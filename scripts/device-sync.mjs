import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentHistory } from '../src/agentHistory/index.mjs';
import { RemoteCodexWorker } from '../src/remoteCodexWorker.mjs';

// A transport only: receiving a packet never launches a process or marks it started.
export async function syncDeviceOnce({ request, history, deviceId, name, outputDir, includeExcerpts = false, codexProjects }) {
  const catalog = await history.catalog();
  const agents = catalog.providers.map(p => p.id);
  const sessions = [];
  for (const s of catalog.sessions) {
    let excerpt = '';
    if (includeExcerpts) {
      const result = await history.detail(s.id, new URLSearchParams({ offset: Math.max(0, s.messageCount - 30), limit: 30 }));
      excerpt = result.messages.filter(m => ['user', 'assistant'].includes(m.role)).map(m => `${m.role}: ${m.text || ''}`).join('\n\n').slice(-24000);
    }
    sessions.push({ nativeId: s.sessionId || s.id, agent: s.agent, title: s.title.slice(0, 120), cwd: s.cwd, status: s.status, updatedAt: s.updatedAt, excerpt });
  }
  for (let i = 0; i < Math.max(sessions.length, 1); i += 20) {
    await request('POST', { action: 'heartbeat', deviceId, name, agents, sessions: sessions.slice(i, i + 20), ...(codexProjects !== undefined ? { codexProjects } : {}) });
  }
  const snapshot = await request('GET');
  const pending = snapshot.handoffs.filter(h => h.deviceId === deviceId && h.status === 'pending');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  let received = 0;
  for (const h of pending) {
    if (!/^[a-f0-9-]{36}$/.test(h.id)) throw new Error('交接包标识无效');
    const target = snapshot.sessions.find(s => s.id === h.targetSessionId);
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
  const environment = { ...process.env };
  if (environment.WORKBENCH_EXECUTE_CODEX === 'true' && process.argv.includes('--once')) throw new Error('Codex 执行模式需要保持连接器运行，请移除 --once');
  if (!environment.WORKBENCH_URL) throw new Error('请设置 WORKBENCH_URL，连接参数见 README「多设备任务中心」');
  const base = new URL(environment.WORKBENCH_URL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('工作台地址无效');
  let token = environment.WORKBENCH_TOKEN;
  if (!token) {
    if (!environment.WORKBENCH_USERNAME || !environment.WORKBENCH_PASSWORD) throw new Error('请设置 WORKBENCH_USERNAME 和 WORKBENCH_PASSWORD，或 WORKBENCH_TOKEN');
    const response = await fetch(new URL('/api/auth/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: environment.WORKBENCH_TENANT || 'default', username: environment.WORKBENCH_USERNAME, password: environment.WORKBENCH_PASSWORD }), signal: AbortSignal.timeout(30000) });
    const result = await response.json(); if (!response.ok) throw new Error(result.message); token = result.token;
  }
  const stateDir = path.resolve(environment.WORKBENCH_DEVICE_DIR || '.workflow-data/device');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  let deviceId;
  try { deviceId = (await readFile(path.join(stateDir, 'id'), 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; deviceId = randomUUID(); await writeFile(path.join(stateDir, 'id'), deviceId, { flag: 'wx', mode: 0o600 }); }
  const history = createAgentHistory({ environment, workspace: () => environment.CODEX_WORKSPACE_DIR || process.cwd() });
  const request = async (method, body, endpoint = '/api/task-center') => {
    const response = await fetch(new URL(endpoint, base), { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
    const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.message), { status: response.status }); return result;
  };
  const outputDir = path.join(stateDir, 'inbox');
  const worker = environment.WORKBENCH_EXECUTE_CODEX === 'true' ? new RemoteCodexWorker({ request, deviceId, directory: path.join(stateDir, 'executions'), workspace: environment.CODEX_WORKSPACE_DIR || process.cwd() }) : null;
  console.log(`同步设备：${hostname()}；交接包目录：${outputDir}`);
  do {
    try { const result = await syncDeviceOnce({ request, history, deviceId, name: environment.WORKBENCH_DEVICE_NAME || hostname(), outputDir, includeExcerpts: environment.WORKBENCH_SYNC_EXCERPTS === 'true', codexProjects: worker ? await worker.projects() : [] }); if (worker) await worker.sync(); console.log(`同步 ${result.sessions} 个会话，接收 ${result.received} 个交接包`); }
    catch (error) { if ([401, 403].includes(error.status) || process.argv.includes('--once')) { worker?.close(); throw error; } console.error(`同步未完成：${error.message}；稍后重试`); }
    if (process.argv.includes('--once')) { worker?.close(); break; }
    await delay(worker ? 3000 : 30000);
  } while (true);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
