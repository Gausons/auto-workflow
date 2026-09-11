// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import { createTaskCenter } from '../src/taskCenter.js';
import { syncDeviceOnce } from '../scripts/device-sync.js';
import { createApp } from '../server.js';

const actor = { id: 'owner' };
const source = { id: 'a'.repeat(64), agent: 'codex', agentLabel: 'Codex', nativeId: 'source', title: '登录修复', cwd: '/repo', updatedAt: new Date().toISOString() };
const history = { catalog: async () => ({ providers: [{ id: 'codex' }, { id: 'claude' }], sessions: [source] }) };
function fixture(t, filename = ':memory:') {
  const database = openDatabase(filename);
  database.createTenant({ id: 'default', token: 'x'.repeat(32) });
  database.createTenant({ id: 'other', token: 'y'.repeat(32) });
  t.after(() => database.close());
  const center = createTaskCenter({ database, tenantId: 'default', history });
  const cmd = input => center.command(input, actor);
  return { database, center, cmd };
}
const handoff = (task, overrides = {}) => ({ action: 'handoff', taskId: task.id, revision: task.revision, mode: 'continue', deviceId: 'remote', agent: 'claude', instruction: '补充回归测试', includeFiles: true, includeSources: true, ...overrides });
const heartbeat = (sessions = []) => ({ action: 'heartbeat', deviceId: 'remote', name: 'Linux', agents: ['claude'], sessions });

test('task linking, context versions, optimistic concurrency and tenant isolation', async t => {
  const { database, center, cmd } = fixture(t);
  const { taskId } = await cmd({ action: 'create', title: '登录修复', sessionId: source.id });
  let task = (await center.snapshot()).tasks[0];
  assert.deepEqual(task.sessionIds, [source.id]);
  await cmd({ action: 'update', taskId, revision: task.revision, title: task.title, status: 'waiting', context: { ...task.context, next: '补充测试' } });
  await assert.rejects(cmd({ action: 'update', taskId, revision: 1, title: 'stale', status: 'ready', context: task.context }), { statusCode: 409 });
  task = (await center.snapshot()).tasks[0];
  assert.equal(task.contextVersion, 2);
  assert.equal(task.context.next, '补充测试');
  await assert.rejects(cmd({ action: 'create', title: '重复归属', sessionId: source.id }), { statusCode: 409 });
  assert.equal((await center.snapshot()).tasks.length, 1, 'failed linking must roll back task creation');
  const other = createTaskCenter({ database, tenantId: 'other', history: { catalog: async () => ({ providers: [], sessions: [] }) } });
  assert.equal((await other.snapshot()).tasks.length, 0);
  await assert.rejects(other.command({ action: 'link', taskId, revision: task.revision, sessionId: source.id }, actor), { statusCode: 404 });
});

test('offline queue, connector receipt, explicit started session and immutable packet', async t => {
  const { database, center, cmd } = fixture(t);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'task-device-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cmd(heartbeat());
  database.mutateTaskCenter('default', data => { data.devices[0].lastSeen = '2020-01-01T00:00:00Z'; });
  assert.equal((await center.snapshot()).devices.find(d => d.id === 'remote').online, false);
  await cmd({ action: 'create', title: '登录修复', sessionId: source.id, context: { files: 'auth.ts @ v1' } });
  let task = (await center.snapshot()).tasks[0];
  const { handoffId } = await cmd(handoff(task));
  task = (await center.snapshot()).tasks[0];
  await assert.rejects(cmd(handoff(task)), { statusCode: 409 });
  assert.equal((await center.snapshot()).handoffs[0].status, 'pending');
  await assert.rejects(cmd({ action: 'ack', handoffId, status: 'started' }), { statusCode: 409 });
  const remoteHistory = { catalog: async () => ({ providers: [{ id: 'claude' }], sessions: [{ ...source, id: 'remote-session', agent: 'claude', title: '继续补充测试' }] }) };
  const result = await syncDeviceOnce({ request: (method, body) => method === 'GET' ? center.snapshot() : cmd(body), history: remoteHistory, deviceId: 'remote', name: 'Linux', outputDir: dir });
  assert.deepEqual(result, { sessions: 1, received: 1 });
  const packet = JSON.parse(await readFile(path.join(dir, handoffId + '.json'), 'utf8'));
  assert.equal(packet.packet.context.files, 'auth.ts @ v1');
  let snapshot = await center.snapshot();
  assert.equal(snapshot.handoffs[0].status, 'received');
  assert.equal(snapshot.tasks[0].status, 'ready', 'receipt must not claim execution');
  await assert.rejects(cmd({ action: 'ack', handoffId, status: 'started', sessionId: source.id }), { statusCode: 400 });
  const remote = snapshot.sessions.find(s => s.deviceId === 'remote');
  await cmd({ action: 'ack', handoffId, status: 'started', sessionId: remote.id });
  await cmd({ action: 'ack', handoffId, status: 'started', sessionId: remote.id });
  snapshot = await center.snapshot();
  assert.equal(snapshot.tasks[0].status, 'running');
  assert.deepEqual(snapshot.tasks[0].sessionIds, [source.id, remote.id]);
  await assert.rejects(cmd({ action: 'ack', handoffId, status: 'cancelled' }), { statusCode: 409 });
  assert.equal((await syncDeviceOnce({ request: (method, body) => method === 'GET' ? center.snapshot() : cmd(body), history: remoteHistory, deviceId: 'remote', name: 'Linux', outputDir: dir })).received, 0);
});

test('branches, references, running source protection, and device identity', async t => {
  const { center, cmd } = fixture(t);
  await cmd(heartbeat([{ nativeId: 'target', agent: 'claude', title: '参考讨论' }]));
  await assert.rejects(center.command(heartbeat(), { id: 'someone-else' }), { statusCode: 403 });
  await cmd({ action: 'create', title: '源任务', sessionId: source.id });
  let snapshot = await center.snapshot(), task = snapshot.tasks[0];
  await cmd({ action: 'update', taskId: task.id, revision: task.revision, title: task.title, context: task.context, status: 'running' });
  task = (await center.snapshot()).tasks[0];
  await assert.rejects(cmd(handoff(task)), { statusCode: 409 });
  const branch = await cmd(handoff(task, { mode: 'branch', includeFiles: false }));
  snapshot = await center.snapshot();
  const child = snapshot.tasks.find(t => t.id === branch.taskId);
  assert.equal(child.parentTaskId, task.id);
  assert.equal(snapshot.tasks.find(t => t.id === task.id).status, 'running');
  assert.equal(snapshot.handoffs[0].packet.context.files, '');
  task = snapshot.tasks.find(t => t.id === task.id);
  await assert.rejects(cmd(handoff(task, { mode: 'reference', targetSessionId: source.id })), { statusCode: 400 });
  const ref = await cmd(handoff(task, { mode: 'reference', targetSessionId: snapshot.sessions.find(s => s.deviceId === 'remote').id }));
  await cmd({ action: 'ack', handoffId: ref.handoffId, status: 'received' });
  await assert.rejects(cmd({ action: 'ack', handoffId: ref.handoffId, status: 'started' }), { statusCode: 409 });
  assert.equal((await center.snapshot()).tasks.find(t => t.id === task.id).status, 'running');
});

test('task data survives reopening the database', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'task-persist-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'data.sqlite');
  let db = openDatabase(filename); db.createTenant({ id: 'default', token: 'x'.repeat(32) });
  await createTaskCenter({ database: db, tenantId: 'default', history }).command({ action: 'create', title: '持久化任务' }, actor);
  db.close(); db = openDatabase(filename);
  assert.equal(db.readTaskCenter('default').tasks[0].title, '持久化任务'); db.close();
});

test('HTTP auth, viewer write rejection, and task UI assets', async t => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'task-http-'));
  const setup = 'setup-'.repeat(8), password = 'test-password-for-tasks';
  const app = createApp({ rootDir, environment: { DEFAULT_TENANT_TOKEN: setup, IDE_HISTORY_CODEX_DIR: path.join(rootDir, 'none'), IDE_HISTORY_CLAUDE_DIR: path.join(rootDir, 'none') } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); await rm(rootDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const req = async (route, method = 'GET', body, token) => {
    const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json() };
  };
  assert.equal((await req('/api/task-center')).status, 401);
  await req('/api/auth/setup', 'POST', { username: 'owner', password }, setup);
  const owner = (await req('/api/auth/login', 'POST', { tenantId: 'default', username: 'owner', password })).data;
  const created = await req('/api/task-center', 'POST', { action: 'create', title: 'HTTP 任务' }, owner.token);
  assert.equal(created.status, 200);
  await req('/api/organization/members', 'POST', { username: 'viewer', role: 'viewer', password }, owner.token);
  const viewer = (await req('/api/auth/login', 'POST', { tenantId: 'default', username: 'viewer', password })).data;
  assert.equal((await req('/api/task-center', 'GET', null, viewer.token)).data.tasks.length, 1);
  assert.equal((await req('/api/task-center', 'POST', { action: 'create', title: 'forbidden' }, viewer.token)).status, 403);
  assert.equal((await fetch(base + '/taskCenter.js')).status, 200);
  assert.match(await (await fetch(base + '/')).text(), /id="taskCenter"/);
});

test('invalid sync batches roll back and cancelled transfers cannot be acknowledged', async t => {
  const { center, cmd } = fixture(t);
  await assert.rejects(cmd({ action: 'create', title: 'invalid', context: null }), { statusCode: 400 });
  await assert.rejects(cmd(heartbeat([null])), { statusCode: 400 });
  assert.equal((await center.snapshot()).devices.length, 1);
  await cmd(heartbeat());
  await cmd({ action: 'create', title: '任务' });
  const task = (await center.snapshot()).tasks[0];
  const h = await cmd(handoff(task));
  await cmd({ action: 'ack', handoffId: h.handoffId, status: 'cancelled' });
  await assert.rejects(cmd({ action: 'ack', handoffId: h.handoffId, status: 'received' }), { statusCode: 409 });
  assert.equal((await center.snapshot()).tasks[0].status, 'ready');
});

test('connector does not acknowledge receipt when writing the packet fails', async t => {
  const { writeFile } = await import('node:fs/promises');
  const { center, cmd } = fixture(t);
  await cmd(heartbeat()); await cmd({ action: 'create', title: '任务' });
  const task = (await center.snapshot()).tasks[0];
  await cmd(handoff(task));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'task-write-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'not-a-directory'); await writeFile(file, 'existing');
  await assert.rejects(syncDeviceOnce({ request: (method, body) => method === 'GET' ? center.snapshot() : cmd(body), history: { catalog: async () => ({ providers: [{ id: 'claude' }], sessions: [] }) }, deviceId: 'remote', name: 'Linux', outputDir: file }));
  assert.equal((await center.snapshot()).handoffs[0].status, 'pending');
});
