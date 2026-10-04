import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, rawDatabase } from '../scripts/testing/database.js';
import { createTaskCenter } from '../src/taskCenter.js';
import { syncDeviceOnce } from '../scripts/device-sync.js';
import { createApp } from '../scripts/testing/database.js';
import type { Actor, Task, TaskCenterData } from '../shared/taskTypes.js';
import type { HistorySession } from '../src/agentHistory/types.js';

const actor: Actor = { id: 'owner' };
const source: HistorySession = { id: 'a'.repeat(64), agent: 'codex', agentLabel: 'Codex', deviceId: 'local', sessionId: 'source', title: '登录修复', cwd: '/repo', workspaces: ['/repo'], model: '', branch: '', status: 'completed', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 0, partial: false };
const history = { catalog: async () => ({ providers: [{ id: 'codex' }, { id: 'claude' }], sessions: [source] }) };
function fixture(t: TestContext, filename: string | undefined = undefined) {
  const database = openDatabase(filename);
  database.createTenant({ id: 'default', token: 'x'.repeat(32) });
  database.createTenant({ id: 'other', token: 'y'.repeat(32) });
  t.after(() => database.close());
  const center = createTaskCenter({ database, tenantId: 'default', history });
  const cmd = (input: unknown) => center.command(input, actor);
  return { database, center, cmd };
}
const handoff = (task: Task, overrides: Record<string, unknown> = {}) => ({ action: 'handoff', taskId: task.id, revision: task.revision, mode: 'continue', deviceId: 'remote', agent: 'claude', instruction: '补充回归测试', includeFiles: true, includeSources: true, ...overrides });
const heartbeat = (sessions: unknown[] = []) => ({ action: 'heartbeat', deviceId: 'remote', name: 'Linux', agents: ['claude'], sessions });

test('task linking, context versions, optimistic concurrency and tenant isolation', async t => {
  const { database, center, cmd } = fixture(t);
  const { taskId } = await cmd({ action: 'create', title: '登录修复', sessionId: source.id });
  let task = (await center.snapshot()).tasks[0]!;
  assert.deepEqual(task.sessionIds, [source.id]);
  await cmd({ action: 'update', taskId, revision: task.revision, title: task.title, status: 'waiting', context: { ...task.context, next: '补充测试' } });
  await assert.rejects(cmd({ action: 'update', taskId, revision: 1, title: 'stale', status: 'ready', context: task.context }), { statusCode: 409 });
  task = (await center.snapshot()).tasks[0]!;
  assert.equal(task.contextVersion, 2);
  assert.equal(task.context?.next, '补充测试');
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
  assert.equal((await center.snapshot()).devices.find(d => d.id === 'remote')?.online, false);
  await cmd({ action: 'create', title: '登录修复', sessionId: source.id, context: { files: 'auth.ts @ v1' } });
  let task = (await center.snapshot()).tasks[0]!;
  const { handoffId } = await cmd(handoff(task));
  task = (await center.snapshot()).tasks[0]!;
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
  const remote = snapshot.sessions.find(s => s.deviceId === 'remote')!;
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
  let snapshot = await center.snapshot(), task = snapshot.tasks[0]!;
  await cmd({ action: 'update', taskId: task.id, revision: task.revision, title: task.title, context: task.context, status: 'running' });
  task = (await center.snapshot()).tasks[0]!;
  await assert.rejects(cmd(handoff(task)), { statusCode: 409 });
  const branch = await cmd(handoff(task, { mode: 'branch', includeFiles: false }));
  snapshot = await center.snapshot();
  const child = snapshot.tasks.find(t => t.id === branch.taskId)!;
  assert.equal(child.parentTaskId, task.id);
  assert.equal(snapshot.tasks.find(t => t.id === task.id)?.status, 'running');
  assert.equal(snapshot.handoffs[0].packet.context.files, '');
  task = snapshot.tasks.find(t => t.id === task.id)!;
  await assert.rejects(cmd(handoff(task, { mode: 'reference', targetSessionId: source.id })), { statusCode: 400 });
  const ref = await cmd(handoff(task, { mode: 'reference', targetSessionId: snapshot.sessions.find(s => s.deviceId === 'remote')!.id }));
  await cmd({ action: 'ack', handoffId: ref.handoffId, status: 'received' });
  await assert.rejects(cmd({ action: 'ack', handoffId: ref.handoffId, status: 'started' }), { statusCode: 409 });
  assert.equal((await center.snapshot()).tasks.find(t => t.id === task.id)?.status, 'running');
});

test('task data survives reopening the database', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'task-persist-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'data.database-key');
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
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  interface ApiData { token?: string; tasks?: unknown[]; [key: string]: unknown }
  const req = async (route: string, method = 'GET', body?: unknown, token?: string) => {
    const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json() as ApiData };
  };
  assert.equal((await req('/api/task-center')).status, 401);
  await req('/api/auth/setup', 'POST', { username: 'owner', password }, setup);
  const owner = (await req('/api/auth/login', 'POST', { tenantId: 'default', username: 'owner', password })).data;
  const updateAbort = new AbortController();
  const updates = await fetch(base + '/api/task-center/updates?since=0', { headers: { Authorization: `Bearer ${owner.token}` }, signal: updateAbort.signal });
  assert.equal(updates.status, 200);
  assert.match(updates.headers.get('content-type') || '', /text\/event-stream/);
  const created = await req('/api/task-center', 'POST', { action: 'create', title: 'HTTP 任务' }, owner.token);
  assert.equal(created.status, 200);
  const update = await updates.body!.getReader().read();
  assert.match(new TextDecoder().decode(update.value), /event: task-center[\s\S]*"version":1/);
  updateAbort.abort();
  await req('/api/organization/members', 'POST', { username: 'viewer', role: 'viewer', password }, owner.token);
  const viewer = (await req('/api/auth/login', 'POST', { tenantId: 'default', username: 'viewer', password })).data;
  assert.equal((await req('/api/task-center', 'GET', null, viewer.token)).data.tasks?.length, 1);
  assert.equal((await req('/api/task-center', 'POST', { action: 'create', title: 'forbidden' }, viewer.token)).status, 403);
  const continuation = '/api/agent-sessions/' + 'a'.repeat(64) + '/continue';
  assert.equal((await req(continuation, 'POST', { message: 'test' })).status, 401);
  assert.equal((await req(continuation, 'POST', { message: 'test' }, viewer.token)).status, 403);
  assert.equal((await req(continuation, 'GET', null, viewer.token)).status, 404);
  for (const page of ['/tasks', '/tasks/new', '/history/' + 'a'.repeat(64), '/settings/account']) {
    const response = await fetch(base + page);
    assert.equal(response.status, 200, page);
    assert.match(await response.text(), /id="app"/);
  }
  assert.equal((await fetch(base + '/taskCenter.js')).status, 404);
  assert.equal((await fetch(base + '/assets/missing.js')).status, 404);
  assert.notEqual((await fetch(base + '/api')).headers.get('content-type'), 'text/html; charset=utf-8');
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

test('task-center mutations advance sync version and notify subscribers', async t => {
  const { database, center, cmd } = fixture(t);
  const versions: number[] = [];
  const unsubscribe = database.subscribeTaskCenter('default', version => versions.push(version));
  await cmd({ action: 'create', title: '实时同步任务' });
  unsubscribe();
  assert.deepEqual(versions, [1]);
  assert.equal((await center.snapshot()).syncVersion, 1);
});

test('connector sync is incremental and the server normalizes oversized excerpts', async t => {
  const { center, cmd } = fixture(t);
  const index: Record<string, string> = {};
  let detailCalls = 0;
  const remoteHistory = {
    catalog: async () => ({ providers: [{ id: 'codex' }], sessions: [{ ...source, id: 'remote-history', sessionId: 'remote-native' }] }),
    detail: async () => { detailCalls++; return { messages: [{ role: 'assistant', text: 'x'.repeat(25000), images: [] }] }; }
  };
  const requests: Array<{ method: string; body?: unknown }> = [];
  const request = async (method: string, body?: unknown) => {
    requests.push({ method, body });
    return method === 'GET' ? center.snapshot() : cmd(body);
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'task-incremental-sync-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await syncDeviceOnce({ request, history: remoteHistory, deviceId: 'remote', name: 'Linux', outputDir: dir, includeExcerpts: true, sessionIndex: index });
  await syncDeviceOnce({ request, history: remoteHistory, deviceId: 'remote', name: 'Linux', outputDir: dir, includeExcerpts: true, sessionIndex: index });
  const posts = requests.filter(item => item.method === 'POST').map(item => item.body as { sessions: Array<{ excerpt: string }> });
  assert.equal(posts[0].sessions[0].excerpt.length, 23000);
  assert.equal(posts[1].sessions.length, 0);
  assert.equal(detailCalls, 1);
  assert.equal((await center.snapshot()).sessions.find(item => item.deviceId === 'remote')?.excerpt?.length, 23000);
});

test('structured history batches stay below the HTTP byte limit and retry only unacknowledged batches', async t => {
  const { center, cmd, database } = fixture(t);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'task-history-batches-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const index: Record<string, string> = {};
  const sessions = Array.from({ length: 8 }, (_, i) => ({ ...source, id: `s${i}`, sessionId: `native${i}`, messageCount: 1 }));
  const remoteHistory = { catalog: async () => ({ providers: [{ id: 'codex' }], sessions }), detail: async () => ({ total: 1, messages: [{ role: 'user', text: '中文内容'.repeat(6000), images: [{ dataUrl: 'data:image/png;base64,' + 'A'.repeat(250000), alt: '测试图片' }] }] }) };
  let failed = false, posts = 0;
  const request = async (method: string, body?: unknown) => {
    if (method === 'GET') return center.snapshot();
    posts++;
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 1000000);
    if (posts === 2 && !failed) { failed = true; throw new Error('模拟断网'); }
    return cmd(body);
  };
  const options = { request, history: remoteHistory, deviceId: 'remote', name: 'Linux', outputDir: dir, includeExcerpts: true, sessionIndex: index };
  await assert.rejects(syncDeviceOnce(options), /模拟断网/);
  assert.ok(Object.keys(index).length > 0 && Object.keys(index).length < sessions.length);
  await syncDeviceOnce(options);
  assert.equal(Object.keys(index).length, sessions.length);
  assert.equal(database.readTaskCenter('default').sessions.filter(session => session.deviceId === 'remote').length, sessions.length);
  assert.ok(database.readTaskCenter('default').sessions.every(session => !session.remoteHistory && database.readRemoteSessionHistory('default', session.id)?.messages[0].role === 'user'));
  const before = database.readTaskCenter('default');
  const existing = before.sessions[0];
  const previewBefore = database.readRemoteSessionHistory('default', existing.id);
  await assert.rejects(cmd({ action: 'heartbeat', deviceId: 'remote', name: 'Linux', agents: ['codex'], sessions: [
    { nativeId: existing.nativeId, agent: 'codex', title: '删除预览应回滚' },
    { nativeId: 'new', agent: 'codex', title: '应回滚', remoteHistory: { offset: 0, total: 1, sourcePartial: false, truncated: false, messages: [{ role: 'user', text: '新预览也应回滚' }] } },
    { nativeId: 'invalid', agent: 'codex', title: '无效数据', remoteHistory: { offset: -1, total: 1, sourcePartial: false, truncated: false, messages: [] } }
  ] }), { statusCode: 400 });
  assert.deepEqual(database.readTaskCenter('default'), before);
  assert.deepEqual(database.readRemoteSessionHistory('default', existing.id), previewBefore);
  assert.equal(database.readRemoteSessionHistory('default', createHash('sha256').update('remote\0codex:new').digest('hex')), null);
});

test('large project metadata gets its own heartbeat without skipping the first history record', async t => {
  const { center, cmd, database } = fixture(t);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'task-project-batches-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const index: Record<string, string> = {};
  const codexProjects = Array.from({ length: 44 }, (_, i) => ({ id: `p${i}`, name: `项目${i}`, cwd: `/repo/${i}`,
    models: Array.from({ length: 30 }, (_, j) => ({ id: `model${j}`, name: `Model ${j}`, description: 'x'.repeat(500) })) }));
  const sessions = Array.from({ length: 2 }, (_, i) => ({ ...source, id: `s${i}`, sessionId: `native${i}`, messageCount: 1 }));
  const remoteHistory = { catalog: async () => ({ providers: [{ id: 'codex' }], sessions }), detail: async () => ({ total: 1,
    messages: [{ role: 'user', text: '含图片的会话', images: [{ dataUrl: 'data:image/png;base64,' + 'A'.repeat(250000), alt: '测试图片' }] }] }) };
  const posts: Array<{ sessions: Array<{ nativeId: string }>; codexProjects?: unknown[] }> = [];
  let failHistory = true;
  const request = async (method: string, body?: unknown) => {
    if (method === 'GET') return center.snapshot();
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 900000);
    const post = body as typeof posts[number];
    posts.push(post);
    if (post.sessions.length && failHistory) { failHistory = false; throw new Error('模拟正文同步断网'); }
    return cmd(body);
  };
  const options = { request, history: remoteHistory, deviceId: 'remote', name: 'Linux', outputDir: dir, includeExcerpts: true, codexProjects, sessionIndex: index };
  await assert.rejects(syncDeviceOnce(options), /模拟正文同步断网/);
  assert.equal(posts[0].sessions.length, 0);
  assert.equal(posts[0].codexProjects?.length, 44);
  assert.equal(posts[1].codexProjects, undefined);
  assert.deepEqual(Object.keys(index), [], 'a metadata heartbeat must not acknowledge an unsent history record');
  await syncDeviceOnce(options);
  const stored = database.readTaskCenter('default');
  assert.deepEqual(stored.sessions.map(session => session.nativeId).sort(), ['native0', 'native1']);
  assert.equal(stored.devices.find(device => device.id === 'remote')?.codexProjects?.length, 44);
  assert.equal(Object.keys(index).length, 2);
  assert.ok(stored.sessions.every(session => database.readRemoteSessionHistory('default', session.id)?.messages[0].images?.[0].dataUrl));
  const previousPosts = posts.length;
  await assert.rejects(syncDeviceOnce({ ...options, codexProjects: [...codexProjects, ...codexProjects] }), /设备项目配置超过同步请求上限/);
  assert.equal(posts.length, previousPosts, 'oversized metadata must fail before sending a request');
});

test('image previews stay outside task state and unchanged heartbeats do not rewrite them', async t => {
  const key = randomUUID(), { database, cmd } = fixture(t, key), raw = rawDatabase(key);
  t.after(() => raw.close());
  const remoteHistory = { offset: 0, total: 1, sourcePartial: false, truncated: false, messages: [{ role: 'user', text: '查看截图', images: [{ dataUrl: 'data:image/png;base64,' + 'A'.repeat(250000) }] }] };
  const sessions = Array.from({ length: 24 }, (_, i) => ({ nativeId: `image-${i}`, agent: 'claude', title: `截图 ${i}`, remoteHistory }));
  for (const session of sessions) await cmd(heartbeat([session]));
  const state = database.readTaskCenter('default');
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 30000);
  assert.equal(Number(raw.prepare("SELECT sum(octet_length(payload::text)) AS bytes FROM remote_session_history WHERE tenant_id = 'default'").get()?.bytes) > 6000000, true);
  const revisions = () => raw.prepare("SELECT session_id, xmin::text AS revision FROM remote_session_history WHERE tenant_id = 'default' ORDER BY session_id").all();
  const before = revisions();
  await cmd(heartbeat());
  await cmd({ action: 'create', title: '与图片无关的新任务' });
  assert.deepEqual(revisions(), before, 'normal mutations must not rewrite preview rows');
  const first = state.sessions[0];
  assert.equal(database.readRemoteSessionHistory('other', first.id), null);
  await assert.rejects(createTaskCenter({ database, tenantId: 'default', history }).command(heartbeat([{ ...sessions[0], remoteHistory: undefined }]), { id: 'unauthorized-owner' }), { statusCode: 403 });
  assert.deepEqual(revisions(), before);
  await cmd(heartbeat([{ ...sessions[0], remoteHistory: undefined }]));
  assert.equal(database.readRemoteSessionHistory('default', first.id), null);
  assert.equal(database.readTaskCenter('default').sessions[0].recordMode, undefined);
  assert.equal(revisions().length, 23);
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

test('moving and unlinking sessions preserve history and enforce both task revisions', async t => {
  const { center, cmd, database } = fixture(t);
  const first = await cmd({ action: 'create', title: '原任务', sessionId: source.id });
  const second = await cmd({ action: 'create', title: '目标任务' });
  const move = { action: 'move', taskId: first.taskId, revision: 1, targetTaskId: second.taskId, targetRevision: 1, sessionId: source.id };
  await assert.rejects(cmd({ ...move, targetRevision: 0 }), { statusCode: 409 });
  assert.deepEqual((await center.snapshot()).tasks.find(v => v.id === first.taskId)?.sessionIds, [source.id]);
  await cmd(move);
  let snapshot = await center.snapshot();
  assert.deepEqual(snapshot.tasks.find(v => v.id === first.taskId)?.sessionIds, []);
  assert.deepEqual(snapshot.tasks.find(v => v.id === second.taskId)?.sessionIds, [source.id]);
  database.mutateTaskCenter('default', data => { data.executions = [{ id: 'active', taskId: second.taskId, status: 'running' }] as TaskCenterData['executions']; });
  await assert.rejects(cmd({ action: 'unlink', taskId: second.taskId, revision: 2, sessionId: source.id }), { statusCode: 409 });
  database.mutateTaskCenter('default', data => { data.executions = []; });
  await cmd({ action: 'unlink', taskId: second.taskId, revision: 2, sessionId: source.id });
  snapshot = await center.snapshot();
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.tasks.find(v => v.id === second.taskId)?.sessionIds.length, 0);
  assert.ok(snapshot.tasks.find(v => v.id === first.taskId)?.events.some(e => e.message.includes('解除会话关联')));
});


test('single Markdown body supports creation, editing, legacy conversion and handoff without field loss', async t => {
  const { database, center, cmd } = fixture(t);
  const content = '# 修复登录\n\n- 保留兼容性\n\n```ts\nconst done = true;\n```';
  const created = await cmd({ action: 'create', content });
  let task = (await center.snapshot()).tasks.find(task => task.id === created.taskId)!;
  assert.equal(task.title, '修复登录'); assert.equal(task.content, content);
  assert.equal(database.readTaskCenter('default').tasks[0].context, undefined);
  await cmd({ action: 'update', taskId: task.id, revision: task.revision, content: '# 更新目标\n\n**完整说明**', status: task.status });
  task = (await center.snapshot()).tasks.find(task => task.id === created.taskId)!;
  assert.equal(task.title, '更新目标'); assert.equal(task.contextVersion, 2);
  await assert.rejects(cmd({ action: 'create', content: '  ' }), { statusCode: 400 });
  await assert.rejects(cmd({ action: 'create', content: 'x'.repeat(64001) }), { statusCode: 400 });
  await cmd(heartbeat());
  const branched = await cmd(handoff(task, { mode: 'branch' }));
  const snapshot = await center.snapshot();
  assert.equal(snapshot.tasks.find(item => item.id === branched.taskId)?.content, task.content);
  assert.equal(snapshot.handoffs[0].packet.content, task.content);
  const legacy = await cmd({ action: 'create', title: '旧任务', context: { goal: '目标', constraints: '约束内容', decisions: '结论', next: '下一步内容', files: 'file.ts' } });
  const oldTask = (await center.snapshot()).tasks.find(item => item.id === legacy.taskId)!;
  for (const text of ['目标', '约束内容', '结论', '下一步内容', 'file.ts']) assert.ok(oldTask.content?.includes(text));
  await cmd({ action: 'update', taskId: oldTask.id, revision: oldTask.revision, content: oldTask.content, status: oldTask.status });
  const migrated = database.readTaskCenter('default').tasks.find(item => item.id === oldTask.id);
  assert.equal(migrated?.content, oldTask.content); assert.equal(migrated?.context, undefined);
});
