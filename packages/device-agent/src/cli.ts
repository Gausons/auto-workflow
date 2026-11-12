import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { deploymentEnvironment, parseDeployment, renewableDeployment } from './connect.js';
import { runBackgroundWorker, runManagedConnector, startBackgroundConnector } from './background.js';
import { listConnectors, stopConnector } from './control.js';
import { checkServiceInstall, installDeviceService, listDeviceServices, runServiceConnector, stopDeviceService } from './service.js';

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    'env-file': { type: 'string' }, once: { type: 'boolean' }, connect: { type: 'string' },
    foreground: { type: 'boolean' }, service: { type: 'boolean' }, status: { type: 'boolean' }, stop: { type: 'string' },
    'background-worker': { type: 'boolean' }, 'service-worker': { type: 'string' }
  } });
  if (values['background-worker']) { await runBackgroundWorker(); return; }
  if (values['service-worker'] !== undefined) { await runServiceConnector(values['service-worker']); return; }
  if (values.help) {
    console.log(`Agent Workbench 开发机连接器

用法：agent-workbench-connector [--env-file <配置文件>] [--once]
      agent-workbench-connector --connect <页面生成的部署参数> [--service]
      agent-workbench-connector --status
      agent-workbench-connector --stop <连接标识>

  --connect <参数>    一键连接：兑换临时令牌，无需输入账号密码
                    默认后台运行，上线后释放终端；不保存设备会话令牌
  --foreground      一键连接时保持前台运行，Ctrl+C 退出
  --service         macOS 常驻连接，登录系统后自动启动并续期设备授权
  --status          查看本机连接器状态、连接标识及日志路径
  --stop <连接标识>  正常停止指定连接器，不终止其他连接
  --env-file <文件>  加载连接配置，已有环境变量优先
                    默认读取 ~/.bugflow/agent.env（文件存在时）
  --once             单次同步，需 WORKBENCH_EXECUTE_CODEX=false
  -v, --version      显示版本
  -h, --help         显示帮助

必填配置：WORKBENCH_URL，以及 WORKBENCH_USERNAME / WORKBENCH_PASSWORD
也可使用 WORKBENCH_TOKEN。默认启用远程执行与历史摘要同步。
默认状态目录：~/.workflow-data/devices/<连接标识>
可用 WORKBENCH_DEVICE_DIR 指定原连接器状态目录，保留设备身份与执行日志。
需要本机安装并登录 Agent；Git 分支管理需要 Git。配置文件方式保持前台运行，Ctrl+C 退出。`);
    return;
  }
  if (values.version) {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    console.log(manifest.version); return;
  }
  if (values.status || values.stop !== undefined) {
    if ((values.status && values.stop !== undefined) || values.connect !== undefined || values['env-file'] || values.once || values.foreground || values.service) throw new Error('--status / --stop 不能与其他运行选项同时使用');
    if (values.stop !== undefined) {
      if (process.platform === 'darwin') {
        const service = await stopDeviceService(homedir(), values.stop);
        if (service) {
          console.log('常驻连接器已停止，登录启动项和本机凭据已移除。');
          if (!service.revoked) throw new Error('服务端未确认撤销设备授权，请检查网络及账号状态');
          return;
        }
      }
      console.log(await stopConnector(homedir(), values.stop) ? '连接器已正常停止。' : '连接器已停止，无需重复停止。');
    } else {
      const [connectors, services] = await Promise.all([listConnectors(homedir()), listDeviceServices(homedir())]);
      const servicesById = new Map(services.map(service => [service.id, service]));
      if (!connectors.length && !services.length) console.log('本机暂无连接器记录。');
      for (const connector of connectors) {
        const service = servicesById.get(connector.id);
        const label = { starting: '启动中', running: '运行中', stopping: '停止中', stopped: '已停止' }[connector.status];
        const status = service && connector.status === 'stopped' ? '未连接' : label;
        console.log(`${connector.id}  ${status}${service ? '（常驻）' : ''}  PID ${connector.pid}  ${connector.origin}`);
        const logFile = service?.logFile ?? connector.logFile;
        if (logFile) console.log(`日志：${logFile}`);
      }
      for (const service of services) {
        if (connectors.some(connector => connector.id === service.id)) continue;
        console.log(`${service.id}  已配置常驻连接\n日志：${service.logFile}`);
      }
    }
    return;
  }
  if (values.foreground && values.connect === undefined) throw new Error('--foreground 需与 --connect 同时使用');
  if (values.service && (values.connect === undefined || values.foreground)) throw new Error('--service 需与 --connect 同时使用，不能与 --foreground 混用');
  if (values.connect !== undefined) {
    if (values['env-file'] || values.once) throw new Error('--connect 不能与 --env-file 或 --once 同时使用');
    const deployment = parseDeployment(values.connect);
    if (values.service) {
      const entry = fileURLToPath(import.meta.url);
      await checkServiceInstall(entry);
      const authorization = await renewableDeployment(values.connect);
      const service = await installDeviceService({ root: homedir(), entry, authorization, environment: process.env });
      console.log(`已启用 macOS 常驻连接，正在接入 ${deployment.url}。\n连接标识：${service.id}\n日志：${service.logFile}`);
      console.log(`查看状态：agent-workbench-connector --status\n停止并移除：agent-workbench-connector --stop ${service.id}`);
      return;
    }
    console.log(`正在连接 ${deployment.url}，验证临时部署令牌…`);
    console.log('默认允许远程执行并同步历史摘要。');
    const environment = await deploymentEnvironment(values.connect, process.env);
    if (values.foreground) {
      console.log('授权成功，正在前台连接设备；Ctrl+C 退出。');
      await runManagedConnector(environment);
    } else {
      console.log('授权成功，正在启动后台连接器…');
      const info = await startBackgroundConnector(environment, fileURLToPath(import.meta.url));
      console.log(`设备已连接，连接器已转入后台（PID ${info.pid}），可以关闭此终端。`);
      console.log(`连接标识：${info.id}\n日志：${info.logFile}`);
      const command = 'npx --yes --registry=https://registry.npmjs.org agent-workbench-connector@latest';
      console.log(`查看状态：${command} --status\n停止连接：${command} --stop ${info.id}`);
    }
    return;
  }
  const config = values['env-file'] ? path.resolve(values['env-file']) : path.join(homedir(), '.bugflow', 'agent.env');
  try {
    const values = parseEnv(await readFile(config, 'utf8'));
    for (const [key, value] of Object.entries(values)) if (process.env[key] === undefined) process.env[key] = value;
  }
  catch (error) {
    if (values['env-file'] || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`无法读取连接配置：${config}`);
  }
  if (!process.env.WORKBENCH_URL) throw new Error('请在 ~/.bugflow/agent.env 配置 WORKBENCH_URL 和登录账号，或使用 --env-file 指定配置文件；运行 --help 查看帮助');
  const environment = { ...process.env };
  // Explicit relative paths retain their usual working-directory meaning; only defaults live under HOME.
  if (environment.WORKBENCH_DEVICE_DIR) environment.WORKBENCH_DEVICE_DIR = path.resolve(environment.WORKBENCH_DEVICE_DIR);
  await runManagedConnector(environment, { once: values.once });
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
