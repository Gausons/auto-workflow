import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { runDeviceConnector } from '../../../src/deviceConnector.js';
import { deploymentEnvironment, parseDeployment } from './connect.js';

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    'env-file': { type: 'string' }, once: { type: 'boolean' }, connect: { type: 'string' }
  } });
  if (values.help) {
    console.log(`Agent Workbench 开发机连接器

用法：agent-workbench-connector [--env-file <配置文件>] [--once]
      agent-workbench-connector --connect <页面生成的部署参数>

  --connect <参数>    一键连接：兑换临时令牌，无需输入账号密码
                    不读取默认配置文件，不保存令牌，不与 --env-file 混用
  --env-file <文件>  加载连接配置，已有环境变量优先
                    默认读取 ~/.bugflow/agent.env（文件存在时）
  --once             单次同步，需 WORKBENCH_EXECUTE_CODEX=false
  -v, --version      显示版本
  -h, --help         显示帮助

必填配置：WORKBENCH_URL，以及 WORKBENCH_USERNAME / WORKBENCH_PASSWORD
也可使用 WORKBENCH_TOKEN。默认启用远程执行与历史摘要同步。
默认状态目录：~/.workflow-data/devices/<连接标识>
可用 WORKBENCH_DEVICE_DIR 指定原连接器状态目录，保留设备身份与执行日志。
需要本机安装并登录 Agent；Git 分支管理需要 Git。保持进程运行，Ctrl+C 退出。`);
    return;
  }
  if (values.version) {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    console.log(manifest.version); return;
  }
  if (values.connect !== undefined) {
    if (values['env-file'] || values.once) throw new Error('--connect 不能与 --env-file 或 --once 同时使用');
    const deployment = parseDeployment(values.connect);
    console.log(`正在连接 ${deployment.url}，验证临时部署令牌…`);
    console.log('默认允许远程执行并同步历史摘要。请先退出该账号已有的连接器，避免重复启动。');
    const environment = await deploymentEnvironment(values.connect, process.env);
    console.log('授权成功，正在连接设备；连接成功后请保持终端运行，Ctrl+C 退出。');
    await runDeviceConnector({ environment, stateRoot: homedir() });
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
  await runDeviceConnector({ environment, once: values.once, stateRoot: homedir() });
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
