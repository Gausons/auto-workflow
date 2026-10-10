import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentHistory } from './agentHistory/index.js';
import { createSessionDelivery } from './sessionDelivery/index.js';
import { RemoteCodexWorker } from './remoteCodexWorker.js';
import { runDeviceControl, watchDeviceUpdates } from './deviceControlClient.js';
import { bindDeviceConnection } from './deviceConnectionIdentity.js';
import { normalizeRemoteHistory, REMOTE_HISTORY_LIMIT } from './remoteHistory.js';
import type { AgentProject, RemoteHistory, TaskCenterData } from '../shared/taskTypes.js';
import type { Environment } from './issueSources/types.js';
import type { HistoryEntry, HistorySession } from './agentHistory/types.js';
import type { SessionImage } from '../shared/historyImageTypes.js';

interface History {
  catalog(): Promise<{ providers: Array<{ id: string }>; sessions: HistorySession[] }>;
  detail?(id: string, params?: URLSearchParams): Promise<{ messages: HistoryEntry[]; total?: number; session?: HistorySession }>;
  images?(id: string): Promise<SessionImage[]>;
}
type Request = (method: string, body?: unknown, endpoint?: string) => Promise<unknown>;
interface SyncOptions {
  request: Request; history: History; deviceId: string; name: string; outputDir: string;
  includeExcerpts?: boolean; codexProjects?: AgentProject[]; resumeCodex?: boolean; sessionIndex?: Record<string, string>;
}
interface DeviceSession { nativeId: string; agent: string; agentLabel: string; title: string; cwd: string; status: string; createdAt: string; updatedAt: string; excerpt: string; archived: boolean; model: string; branch: string; remoteHistory?: RemoteHistory }
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
const sessionFingerprint = (session: HistorySession, includeExcerpts: boolean) => createHash('sha256').update(JSON.stringify({
  format: 4, messageCount: session.messageCount, partial: session.partial, model: session.model, branch: session.branch,
  nativeId: session.sessionId || session.id, agent: session.agent, title: session.title, cwd: session.cwd,
  status: session.status, createdAt: session.createdAt, updatedAt: session.updatedAt, archived: session.archived === true, includeExcerpts
})).digest('hex');

export async function syncDeviceOnce({ request, history, deviceId, name, outputDir, includeExcerpts = false, codexProjects, resumeCodex = false, sessionIndex }: SyncOptions) {
  const catalog = await history.catalog();
  const agents = catalog.providers.map(provider => provider.id);
  const sessions: Array<{ value: DeviceSession; key: string; fingerprint: string; historyId: string }> = [];
  const currentKeys = new Set<string>();
  // A native session can have multiple rollout files. Use the newest source
  // consistently for both the preview and images, including unchanged sessions.
  for (const s of [...catalog.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))) {
    const nativeId = s.sessionId || s.id;
    const key = `${s.agent}\0${nativeId}`;
    if (currentKeys.has(key)) continue;
    currentKeys.add(key);
    const fingerprint = sessionFingerprint(s, includeExcerpts);
    if (sessionIndex?.[key] === fingerprint) continue;
    let excerpt = '';
    let remoteHistory: RemoteHistory | undefined;
    if (includeExcerpts) {
      if (!history.detail) throw new Error('历史服务不支持读取会话详情');
      let offset = Math.max(0, s.messageCount - REMOTE_HISTORY_LIMIT);
      let result = await history.detail(s.id, new URLSearchParams({ offset: String(offset), limit: String(REMOTE_HISTORY_LIMIT) }));
      // The parser may expose fewer records than the source count after hitting
      // its safety limit, or the file may have changed since catalog scanning.
      if (result.total !== undefined && offset !== Math.max(0, result.total - REMOTE_HISTORY_LIMIT)) {
        offset = Math.max(0, result.total - REMOTE_HISTORY_LIMIT);
        result = await history.detail(s.id, new URLSearchParams({ offset: String(offset), limit: String(REMOTE_HISTORY_LIMIT) }));
      }
      const messages = history.images ? result.messages.map(message => ({ ...message, images: message.images.map(image => image.dataUrl
        ? { external: true, alt: '图片单独同步，可在「会话图片」中查看。' } : image) })) : result.messages;
      remoteHistory = normalizeRemoteHistory({ messages, offset, total: Math.max(result.session?.messageCount ?? result.total ?? s.messageCount, offset + result.messages.length), sourcePartial: result.session?.partial ?? s.partial, truncated: false });
      excerpt = result.messages.filter(message => ['user', 'assistant'].includes(message.role)).map(message => `${message.role}: ${message.text || ''}`).join('\n\n').slice(-23000);
    }
    sessions.push({ key, fingerprint, historyId: s.id, value: { nativeId, agent: s.agent, agentLabel: s.agentLabel, title: s.title.slice(0, 120), cwd: s.cwd, status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt, excerpt, archived: s.archived === true, model: s.model, branch: s.branch, remoteHistory } });
  }
  let firstHeartbeat = true;
  for (let i = 0; i < sessions.length || firstHeartbeat;) {
    const batch: typeof sessions = [];
    const body = { action: 'heartbeat', deviceId, name, agents, capabilities: { resumeCodex, gitBranches: resumeCodex }, sessions: [] as DeviceSession[], ...(firstHeartbeat && codexProjects !== undefined ? { codexProjects } : {}) };
    if (Buffer.byteLength(JSON.stringify(body)) > 900000) throw new Error('设备项目配置超过同步请求上限');
    do {
      const item = sessions[i + batch.length];
      if (!item) break;
      body.sessions.push(item.value);
      if (Buffer.byteLength(JSON.stringify(body)) > 900000) {
        body.sessions.pop();
        if (!batch.length && body.codexProjects === undefined) throw new Error('单条设备历史超过同步请求上限');
        break;
      }
      batch.push(item);
    } while (batch.length < 20);
    await request('POST', body);
    for (const item of batch) {
      if (includeExcerpts && history.images) {
        // Do not bump the preview fingerprint format or backfill unchanged
        // sessions. Images from changed sessions outlive the 30-record window.
        const sessionId = createHash('sha256').update(`${deviceId}\0${item.value.agent}:${item.value.nativeId}`).digest('hex');
        const images = await history.images(item.historyId);
        const saved = new Set<string>();
        let offset = 0;
        while (images.length) {
          const page = await request('GET', undefined, `/api/agent-sessions/${sessionId}/images?offset=${offset}&limit=50`) as { images: Array<{ id: string }>; total: number };
          for (const image of page.images) saved.add(image.id);
          offset += page.images.length;
          if (offset >= page.total || !page.images.length) break;
        }
        for (const image of images) {
          // The source can grow after its heartbeat. Publish those new records
          // on the next sync before uploading their images; keep this boundary.
          if (image.record > item.value.remoteHistory!.total) continue;
          if (!saved.has(image.id)) await request('POST', { deviceId, nativeId: item.value.nativeId, agent: item.value.agent, image }, '/api/task-center/history-images');
        }
      }
      // Only acknowledge after all image writes succeed. Retrying a partial
      // upload lists the saved objects and sends only the missing images.
      if (sessionIndex) sessionIndex[item.key] = item.fingerprint;
    }
    firstHeartbeat = false;
    i += batch.length;
  }
  if (sessionIndex) for (const key of Object.keys(sessionIndex)) if (!currentKeys.has(key)) delete sessionIndex[key];
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
  return { sessions: catalog.sessions.length, received };
}

export async function runDeviceConnector({ environment = { ...process.env }, once = false, stateRoot = process.cwd() }: { environment?: Environment; once?: boolean; stateRoot?: string } = {}) {
  const defaults = deviceConnectorDefaults(environment);
  if (defaults.execute && once) throw new Error('Agent 执行模式需要保持连接器运行；如需单次同步，请设置 WORKBENCH_EXECUTE_CODEX=false');
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
  const stateDir = await resolveDeviceStateDirectory(environment, connectionIdentity, stateRoot);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await bindDeviceConnection(stateDir, connectionIdentity);
  let deviceId;
  try { deviceId = (await readFile(path.join(stateDir, 'id'), 'utf8')).trim(); }
  catch (caught: unknown) { const error = asError(caught); if (error.code !== 'ENOENT') throw error; deviceId = randomUUID(); await writeFile(path.join(stateDir, 'id'), deviceId, { flag: 'wx', mode: 0o600 }); }
  const history = createAgentHistory({ environment, workspace: () => defaults.workspace });
  const delivery = createSessionDelivery({ history, environment });
  const stopping = new AbortController();
  let shuttingDown = false, heartbeatAgents = ['codex'];
  const request: Request = async (method, body, endpoint = '/api/task-center') => {
    const binary = body instanceof Uint8Array;
    const controller = new AbortController(), abort = () => controller.abort();
    const timer = setTimeout(abort, endpoint.includes('/transfer') ? 180000 : 60000);
    if (!shuttingDown) {
      stopping.signal.addEventListener('abort', abort, { once: true });
      if (stopping.signal.aborted) abort();
    }
    try {
      const response = await fetch(new URL(endpoint, base), { method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
        ...(body !== undefined ? { body: binary ? Buffer.from(body) : JSON.stringify(body) } : {}),
        signal: controller.signal });
      if (!response.ok) { const result = record(await response.json()); throw Object.assign(new Error(String(result.message || '请求失败')), { status: response.status }); }
      if (method === 'GET' && endpoint.includes('/transfer/objects/')) return new Uint8Array(await response.arrayBuffer());
      const result = record(await response.json());
      if (method === 'POST' && record(body).action === 'heartbeat') heartbeatAgents = record(body).agents as string[];
      return result;
    } finally { clearTimeout(timer); stopping.signal.removeEventListener('abort', abort); }
  };
  const outputDir = path.join(stateDir, 'inbox');
  const sessionIndexFile = path.join(stateDir, 'session-sync-index.json');
  let sessionIndex: Record<string, string> = {};
  try {
    const saved = JSON.parse(await readFile(sessionIndexFile, 'utf8')) as unknown;
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) sessionIndex = Object.fromEntries(Object.entries(saved).filter(([key, value]) => key.length <= 500 && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)).slice(0, 100_000));
  } catch (caught: unknown) { if (asError(caught).code !== 'ENOENT') console.warn('会话增量索引不可用，将执行一次完整同步'); }
  const deviceParams = new URLSearchParams({ deviceId });
  const workerRequest: Request = (method, body, endpoint) => request(method, body, method === 'GET' && !endpoint ? `/api/task-center/device-state?${deviceParams}` : endpoint);
  const worker = defaults.execute ? new RemoteCodexWorker({ request: workerRequest, signal: stopping.signal, deviceId, directory: path.join(stateDir, 'executions'), workspace: defaults.workspace, contextSource: { catalog: () => history.catalog(), delivery } }) : null;
  const stop = () => stopping.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(`设备：${environment.WORKBENCH_DEVICE_NAME || hostname()}；模式：${worker ? '远程执行' : '仅同步'}；交接包目录：${outputDir}`);
  const reportError = (caught: unknown) => {
    const error = asError(caught);
    if ((typeof error.status === 'number' && [401, 403].includes(error.status)) || once) { stopping.abort(); throw error; }
    console.error(`同步未完成：${error.message}；稍后重试`);
  };
  const heartbeat = async () => {
    await request('POST', { action: 'heartbeat', deviceId, name: environment.WORKBENCH_DEVICE_NAME || hostname(), agents: heartbeatAgents,
      sessions: [], capabilities: { resumeCodex: Boolean(worker), gitBranches: Boolean(worker) } });
  };
  const syncHistory = async () => {
    const result = await syncDeviceOnce({ request, history, deviceId, name: environment.WORKBENCH_DEVICE_NAME || hostname(), outputDir,
      includeExcerpts: defaults.includeExcerpts, codexProjects: worker ? await worker.projects() : [], resumeCodex: Boolean(worker), sessionIndex });
    const stagingIndex = sessionIndexFile + '.pending';
    await writeFile(stagingIndex, JSON.stringify(sessionIndex), { mode: 0o600 });
    await rename(stagingIndex, sessionIndexFile);
    console.log(`同步 ${result.sessions} 个会话，接收 ${result.received} 个交接包`);
  };
  const historyLoop = async () => {
    do {
      if (stopping.signal.aborted) return;
      try { await syncHistory(); } catch (error) { if (!stopping.signal.aborted) reportError(error); }
      if (once || stopping.signal.aborted) return;
      await delay(30_000, undefined, { signal: stopping.signal }).catch(error => { if (!stopping.signal.aborted) throw error; });
    } while (!stopping.signal.aborted);
  };
  const loops: Promise<void>[] = [];
  try {
    if (worker) {
      try { await heartbeat(); } catch (error) { if (!stopping.signal.aborted) reportError(error); }
      loops.push(runDeviceControl({ signal: stopping.signal, work: () => worker.sync(), controls: () => worker.syncControls(), heartbeat,
        onError: reportError,
        subscribe: (wake, signal) => watchDeviceUpdates({ url: new URL(`/api/task-center/device-updates?${deviceParams}`, base), token, signal, wake,
          onError: () => console.warn('设备通知通道暂不可用，继续每 3 秒补查远端控制请求') }) }));
    }
    loops.push(historyLoop());
    await Promise.all(loops);
  } finally {
    stopping.abort();
    await Promise.allSettled(loops);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    shuttingDown = true;
    await worker?.shutdown();
  }
}
