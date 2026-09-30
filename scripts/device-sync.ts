import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentHistory } from '../src/agentHistory/index.js';
import { createSessionDelivery } from '../src/sessionDelivery/index.js';
import { RemoteCodexWorker } from '../src/remoteCodexWorker.js';
import { bindDeviceConnection } from '../src/deviceConnectionIdentity.js';
import type { AgentProject, TaskCenterData } from '../shared/taskTypes.js';
import type { Environment } from '../src/issueSources/types.js';
import type { HistoryEntry, HistorySession } from '../src/agentHistory/types.js';

interface History {
  catalog(): Promise<{ providers: Array<{ id: string }>; sessions: HistorySession[] }>;
  detail?(id: string, params?: URLSearchParams): Promise<{ messages: HistoryEntry[] }>;
}
type Request = (method: string, body?: unknown, endpoint?: string) => Promise<unknown>;
interface SyncOptions {
  request: Request; history: History; deviceId: string; name: string; outputDir: string;
  includeExcerpts?: boolean; codexProjects?: AgentProject[]; resumeCodex?: boolean;
}
interface DeviceSession { nativeId: string; agent: string; title: string; cwd: string; status: string; createdAt: string; updatedAt: string; excerpt: string; archived: boolean }
type ErrorLike = Error & { code?: string; status?: number };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asError = (value: unknown): ErrorLike => value instanceof Error ? value as ErrorLike : new Error(String(value));

export function deviceStateDirectory(environment: Environment, identity: { origin: string; tenantId: string; userId: string }, root = process.cwd()) {
  if (environment.WORKBENCH_DEVICE_DIR) return path.resolve(root, environment.WORKBENCH_DEVICE_DIR);
  const connection = `${identity.origin}\0${identity.tenantId}\0${identity.userId}`;
  return path.resolve(root, '.workflow-data', 'devices', createHash('sha256').update(connection).digest('hex').slice(0, 24));
}

export async function resolveDeviceStateDirectory(environment: Environment, identity: { origin: string; tenantId: string; userId: string }, root = process.cwd()) {
  if (environment.WORKBENCH_DEVICE_DIR) return deviceStateDirectory(environment, identity, root);
  const legacy = path.resolve(root, '.workflow-data', 'device');
  try {
    const saved = record(JSON.parse(await readFile(path.join(legacy, 'connection.json'), 'utf8')));
    if (saved.origin === identity.origin && saved.tenantId === identity.tenantId && saved.userId === identity.userId) return legacy;
  } catch (caught: unknown) {
    const error = asError(caught);
    if (error.code !== 'ENOENT') throw caught;
  }
  return deviceStateDirectory(environment, identity, root);
}

export function deviceConnectorDefaults(environment: Environment) {
  return {
    execute: environment.WORKBENCH_EXECUTE_CODEX !== 'false',
    includeExcerpts: environment.WORKBENCH_SYNC_EXCERPTS !== 'false',
    workspace: environment.CODEX_WORKSPACE_DIR || homedir()
  };
}

// A transport only: receiving a packet never launches a process or marks it started.
export async function syncDeviceOnce({ request, history, deviceId, name, outputDir, includeExcerpts = false, codexProjects, resumeCodex = false }: SyncOptions) {
  const catalog = await history.catalog();
  const agents = catalog.providers.map(provider => provider.id);
  const sessions: DeviceSession[] = [];
  for (const s of catalog.sessions) {
    let excerpt = '';
    if (includeExcerpts) {
      if (!history.detail) throw new Error('历史服务不支持读取会话详情');
      const result = await history.detail(s.id, new URLSearchParams({ offset: String(Math.max(0, s.messageCount - 30)), limit: '30' }));
      excerpt = result.messages.filter(message => ['user', 'assistant'].includes(message.role)).map(message => `${message.role}: ${message.text || ''}`).join('\n\n').slice(-24000);
    }
    sessions.push({ nativeId: s.sessionId || s.id, agent: s.agent, title: s.title.slice(0, 120), cwd: s.cwd, status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt, excerpt, archived: s.archived === true });
  }
  for (let i = 0; i < Math.max(sessions.length, 1); i += 20) {
    await request('POST', { action: 'heartbeat', deviceId, name, agents, capabilities: { resumeCodex }, sessions: sessions.slice(i, i + 20), ...(codexProjects !== undefined ? { codexProjects } : {}) });
  }
  const snapshot = await request('GET') as TaskCenterData;
  const pending = snapshot.handoffs.filter(handoff => handoff.deviceId === deviceId && handoff.status === 'pending');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  let received = 0;
  for (const h of pending) {
    if (!/^[a-f0-9-]{36}$/.test(h.id)) throw new Error('交接包标识无效');
    const target = snapshot.sessions.find(session => session.id === h.targetSessionId);
    const packet = { ...h, targetNativeSessionId: target?.nativeId || null };
    const filename = path.join(outputDir, h.id + '.json');
    const staging = filename + '.pending';
    await writeFile(staging, JSON.stringify(packet, null, 2), { mode: 0o600 });
    await rename(staging, filename);
    await request('POST', { action: 'ack', handoffId: h.id, status: 'received', note: '设备连接器已保存交接包；尚未启动 Agent' });
    received++;
  }
  return { sessions: sessions.length, received };
}

async function main() {
  const environment: Environment = { ...process.env };
  const defaults = deviceConnectorDefaults(environment);
  if (defaults.execute && process.argv.includes('--once')) throw new Error('Agent 执行模式需要保持连接器运行；如需单次同步，请设置 WORKBENCH_EXECUTE_CODEX=false');
  if (!environment.WORKBENCH_URL) throw new Error('请设置 WORKBENCH_URL，连接参数见 README「多设备执行」');
  const base = new URL(environment.WORKBENCH_URL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('工作台地址无效');
  let token = environment.WORKBENCH_TOKEN;
  if (!token) {
    if (!environment.WORKBENCH_USERNAME || !environment.WORKBENCH_PASSWORD) throw new Error('请设置 WORKBENCH_USERNAME 和 WORKBENCH_PASSWORD，或 WORKBENCH_TOKEN');
    const response = await fetch(new URL('/api/auth/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: environment.WORKBENCH_USERNAME, password: environment.WORKBENCH_PASSWORD }), signal: AbortSignal.timeout(30000) });
    const result = record(await response.json()); if (!response.ok) throw new Error(String(result.message || '登录失败'));
    if (typeof result.token !== 'string') throw new Error('登录响应缺少令牌');
    token = result.token;
  }
  const identityResponse = await fetch(new URL('/api/auth/session', base), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  const identity = record(await identityResponse.json());
  if (!identityResponse.ok) throw new Error(String(identity.message || '连接器登录已失效'));
  const tenantId = record(identity.tenant).id, userId = record(identity.user).id;
  if (typeof tenantId !== 'string' || typeof userId !== 'string' || !Array.isArray(identity.permissions) || !identity.permissions.includes('work.execute')) throw new Error('接入设备需要操作员或管理员权限');
  const connectionIdentity = { origin: base.origin, tenantId, userId };
  const stateDir = await resolveDeviceStateDirectory(environment, connectionIdentity);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await bindDeviceConnection(stateDir, connectionIdentity);
  let deviceId;
  try { deviceId = (await readFile(path.join(stateDir, 'id'), 'utf8')).trim(); }
  catch (caught: unknown) { const error = asError(caught); if (error.code !== 'ENOENT') throw error; deviceId = randomUUID(); await writeFile(path.join(stateDir, 'id'), deviceId, { flag: 'wx', mode: 0o600 }); }
  const history = createAgentHistory({ environment, workspace: () => defaults.workspace });
  const delivery = createSessionDelivery({ history, environment });
  const request: Request = async (method, body, endpoint = '/api/task-center') => {
    const binary = body instanceof Uint8Array;
    const response = await fetch(new URL(endpoint, base), { method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
      ...(body !== undefined ? { body: binary ? Buffer.from(body) : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(endpoint.includes('/transfer') ? 180000 : 60000) });
    if (!response.ok) { const result = record(await response.json()); throw Object.assign(new Error(String(result.message || '请求失败')), { status: response.status }); }
    if (method === 'GET' && endpoint.includes('/transfer/objects/')) return new Uint8Array(await response.arrayBuffer());
    return record(await response.json());
  };
  const outputDir = path.join(stateDir, 'inbox');
  const worker = defaults.execute ? new RemoteCodexWorker({ request, deviceId, directory: path.join(stateDir, 'executions'), workspace: defaults.workspace, contextSource: { catalog: () => history.catalog(), delivery } }) : null;
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(`设备：${environment.WORKBENCH_DEVICE_NAME || hostname()}；模式：${worker ? '远程执行' : '仅同步'}；交接包目录：${outputDir}`);
  const reportError = (caught: unknown) => {
    const error = asError(caught);
    if ((typeof error.status === 'number' && [401, 403].includes(error.status)) || process.argv.includes('--once')) throw error;
    console.error(`同步未完成：${error.message}；稍后重试`);
  };
  try {
    do {
      try {
        const result = await syncDeviceOnce({ request, history, deviceId, name: environment.WORKBENCH_DEVICE_NAME || hostname(), outputDir,
          includeExcerpts: defaults.includeExcerpts, codexProjects: worker ? await worker.projects() : [], resumeCodex: Boolean(worker) });
        console.log(`同步 ${result.sessions} 个会话，接收 ${result.received} 个交接包`);
      } catch (caught: unknown) { reportError(caught); }
      // A history/discovery failure must not prevent approvals or stop requests
      // for an execution that is already running on this connector.
      if (worker && !stopping.signal.aborted) {
        try { await worker.sync(); } catch (caught: unknown) { reportError(caught); }
      }
      if (process.argv.includes('--once') || stopping.signal.aborted) break;
      await delay(worker ? 3000 : 30000, undefined, { signal: stopping.signal }).catch(error => { if (!stopping.signal.aborted) throw error; });
    } while (!stopping.signal.aborted);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await worker?.shutdown();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
