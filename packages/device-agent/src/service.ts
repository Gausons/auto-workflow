import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deviceDeploymentOrigin } from '../../../shared/deviceDeployment.js';
import { resolveDeviceStateDirectory } from '../../../src/deviceConnector.js';
import { bindDeviceConnection } from '../../../src/deviceConnectionIdentity.js';
import { runManagedConnector } from './background.js';
import { connectorDirectory, connectorId, listConnectors, serviceProfilePath } from './control.js';

type Launchctl = (args: string[]) => Promise<void>;
type Authorization = { origin: string; token: string; tenantId: string; userId: string };
interface ServiceProfile {
  origin: string;
  token: string;
  stateDir: string;
  environment: NodeJS.ProcessEnv;
}

const launchctl: Launchctl = async args => {
  await promisify(execFile)('/bin/launchctl', args, { timeout: 120_000 });
};
const label = (id: string) => `top.autoworkflow.connector.${id}`;
const domain = () => `gui/${process.getuid?.()}`;
const plistPath = (root: string, id: string) => path.join(root, 'Library', 'LaunchAgents', label(id) + '.plist');
const serviceLog = (root: string, id: string) => path.join(connectorDirectory(root), id + '.service.log');
const errorCode = (error: unknown) => error instanceof Error && 'code' in error ? error.code : undefined;

// Serialize installation and removal separately from the running worker's
// control lease. The OS releases this lease even if the CLI crashes.
async function withServiceMutation<T>(id: string, action: () => Promise<T>) {
  const port = 61_000 + Number.parseInt(id.slice(0, 8), 16) % 4000;
  const lease = createServer(socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      lease.once('error', reject);
      lease.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
  } catch (error) {
    if (errorCode(error) === 'EADDRINUSE') throw new Error('常驻配置正在修改或管理端口被占用，请稍后重试');
    throw error;
  }
  try { return await action(); }
  finally { await new Promise<void>(resolve => lease.close(() => resolve())); }
}

const serviceSettings = [
  'PATH', 'WORKBENCH_DEVICE_NAME', 'WORKBENCH_EXECUTE_CODEX', 'WORKBENCH_SYNC_EXCERPTS',
  'CODEX_WORKSPACE_DIR', 'CODEX_EXECUTABLE', 'ACP_ENABLED', 'IDE_HISTORY_SCOPE',
  'IDE_HISTORY_CODEX_DIR', 'IDE_HISTORY_CLAUDE_DIR'
] as const;
function serviceEnvironment(environment: NodeJS.ProcessEnv) {
  const saved: NodeJS.ProcessEnv = {};
  for (const key of serviceSettings) {
    const value = environment[key];
    if (typeof value === 'string') saved[key] = value;
  }
  for (const key of ['CODEX_WORKSPACE_DIR', 'IDE_HISTORY_CODEX_DIR', 'IDE_HISTORY_CLAUDE_DIR'] as const) {
    if (saved[key]) saved[key] = path.resolve(saved[key]);
  }
  if (saved.CODEX_EXECUTABLE?.includes('/')) saved.CODEX_EXECUTABLE = path.resolve(saved.CODEX_EXECUTABLE);
  return saved;
}

const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function launchAgent(root: string, id: string, entry: string) {
  const args = [process.execPath, entry, '--service-worker', id];
  const log = xml(serviceLog(root, id));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(id)}</string>
  <key>ProgramArguments</key>
  <array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(root)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>90</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

export async function checkServiceInstall(entry: string) {
  if (process.platform !== 'darwin' || process.getuid?.() === 0) {
    throw new Error('常驻连接目前仅支持已登录 macOS 的普通用户，请直接在本机终端运行');
  }
  if (entry.split(path.sep).includes('_npx') || !entry.endsWith('.mjs')) {
    throw new Error('常驻连接需要固定安装路径，请先运行 pnpm add -g agent-workbench-connector，再使用已安装的命令接入');
  }
  try { await launchctl(['print', domain()]); }
  catch { throw new Error('无法访问 macOS 登录会话，请登录桌面后运行常驻接入命令'); }
}

async function readProfile(root: string, id: string): Promise<ServiceProfile | undefined> {
  const file = await open(serviceProfilePath(root, id), constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
    if (errorCode(error) !== 'ENOENT') throw error;
  });
  if (!file) return;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.() || metadata.size > 65_536) {
      throw new Error('常驻凭据文件权限或格式无效');
    }
    let value: unknown;
    try { value = JSON.parse(await file.readFile('utf8')); }
    catch { throw new Error('常驻凭据文件无效，请重新接入'); }
    if (!value || typeof value !== 'object' || !('origin' in value) || typeof value.origin !== 'string' ||
        !('token' in value) || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
        !('stateDir' in value) || typeof value.stateDir !== 'string' || !path.isAbsolute(value.stateDir) ||
        connectorId(value.stateDir) !== id || !('environment' in value) || !value.environment || typeof value.environment !== 'object') {
      throw new Error('常驻凭据文件无效，请重新接入');
    }
    return { origin: deviceDeploymentOrigin(value.origin), token: value.token, stateDir: value.stateDir,
      environment: serviceEnvironment(value.environment as NodeJS.ProcessEnv) };
  } finally { await file.close(); }
}

async function revokeAuthorization({ origin, token }: Pick<Authorization, 'origin' | 'token'>) {
  try {
    const response = await fetch(new URL('/api/auth/logout', origin), { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    return response.ok || response.status === 401;
  } catch { return false; }
}

export async function installDeviceService({ root, entry, authorization, environment, control = launchctl }: {
  root: string; entry: string; authorization: Authorization; environment: NodeJS.ProcessEnv; control?: Launchctl;
}) {
  try {
    const directory = await resolveDeviceStateDirectory(environment, authorization, root);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stateDir = await realpath(directory);
    const { origin, tenantId, userId, token } = authorization;
    await bindDeviceConnection(stateDir, { origin, tenantId, userId });
    const id = connectorId(stateDir);
    return await withServiceMutation(id, async () => {
      const active = (await listConnectors(root)).find(item => item.id === id && item.status !== 'stopped');
      if (active) throw new Error(`该连接器已在运行，请先使用 --stop ${id}`);
      const profileFile = serviceProfilePath(root, id);
      const plist = plistPath(root, id);
      await mkdir(connectorDirectory(root), { recursive: true, mode: 0o700 });
      await mkdir(path.dirname(plist), { recursive: true, mode: 0o700 });
      const file = await open(profileFile, 'wx', 0o600).catch(error => {
        if (errorCode(error) === 'EEXIST') throw new Error(`该设备已配置常驻连接，请先使用 --stop ${id}`);
        throw error;
      });
      let wrotePlist = false;
      try {
        const profile: ServiceProfile = { origin, token, stateDir, environment: serviceEnvironment(environment) };
        try { await file.writeFile(JSON.stringify(profile)); }
        finally { await file.close(); }
        const logFile = serviceLog(root, id);
        const log = await open(logFile, constants.O_NOFOLLOW | constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
        try { await log.chmod(0o600); }
        finally { await log.close(); }
        const registration = await open(plist, 'wx', 0o600);
        wrotePlist = true;
        try { await registration.writeFile(launchAgent(root, id, entry)); }
        finally { await registration.close(); }
        try { await control(['bootstrap', domain(), plist]); }
        catch { throw new Error('macOS 无法加载常驻连接器，请检查登录会话和系统登录项设置'); }
        return { id, logFile };
      } catch (error) {
        if (wrotePlist) await rm(plist, { force: true });
        await rm(profileFile, { force: true });
        throw error;
      }
    });
  } catch (error) {
    if (!(await revokeAuthorization(authorization))) {
      throw new Error('常驻接入失败，服务端未确认撤销本次授权，请检查网络及账号状态', { cause: error });
    }
    throw error;
  }
}

export async function listDeviceServices(root: string) {
  const files = await readdir(connectorDirectory(root)).catch(error => {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  });
  return files.filter(file => /^[a-f0-9]{24}\.service\.json$/.test(file)).map(file => {
    const id = file.slice(0, 24);
    return { id, logFile: serviceLog(root, id) };
  });
}

export async function stopDeviceService(root: string, id: string, control: Launchctl = launchctl) {
  const filename = serviceProfilePath(root, id);
  const exists = () => lstat(filename).catch(error => {
    if (errorCode(error) !== 'ENOENT') throw error;
  });
  if (!(await exists())) return;
  return withServiceMutation(id, async () => {
    if (!(await exists())) return;
    // A damaged local credential still needs to be removable.
    const profile = await readProfile(root, id).catch(() => undefined);
    const target = `${domain()}/${label(id)}`;
    let loaded = true;
    try { await control(['print', target]); }
    catch (error) {
      if (errorCode(error) !== 113) throw new Error('无法检查 macOS 常驻连接器状态，请登录桌面后重试');
      loaded = false;
    }
    if (loaded) {
      try { await control(['bootout', target]); }
      catch { throw new Error('macOS 无法停止常驻连接器，请稍后重试'); }
    }
    await rm(plistPath(root, id), { force: true });
    await rm(filename, { force: true });
    return { revoked: profile ? await revokeAuthorization(profile) : false };
  });
}

export async function runServiceConnector(id: string) {
  const root = homedir();
  const profile = await readProfile(root, id);
  if (!profile) {
    console.error('常驻凭据已移除，请重新接入');
    return;
  }
  const environment = { ...process.env, ...profile.environment, WORKBENCH_URL: profile.origin,
    WORKBENCH_TOKEN: profile.token, WORKBENCH_DEVICE_DIR: profile.stateDir };
  try { await runManagedConnector(environment, { serviceId: id, logFile: serviceLog(root, id) }); }
  catch (error) {
    if (error instanceof Error && 'status' in error && [401, 403].includes(Number(error.status))) {
      console.error('常驻设备授权已失效，请停止旧连接器并在网页重新生成接入命令');
      return;
    }
    if (error instanceof Error && error.name === 'AbortError') return;
    throw new Error((error instanceof Error ? error.message : '常驻连接器执行失败').replaceAll(profile.token, '[已隐藏]'));
  }
}
