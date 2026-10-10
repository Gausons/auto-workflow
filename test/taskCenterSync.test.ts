import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, rawDatabase, createApp } from '../scripts/testing/database.js';
import { createTaskCenter } from '../src/taskCenter.js';
import { applyTaskCenterDelta, type TaskCenterDelta } from '../shared/taskCenterSync.js';
import type { Session, TaskCenterData } from '../shared/taskTypes.js';

const actor = { id: 'owner' };
function fixture(t: TestContext) {
  const key = randomUUID(), database = openDatabase(key);
  for (const id of ['default', 'other']) database.createTenant({ id, token: id.repeat(40) });
  t.after(() => database.close());
  const sessions: Session[] = [];
  const center = createTaskCenter({ database, tenantId: 'default', history: { catalog: async () => ({ providers: [], sessions }) } });
  return { key, database, center, sessions };
}
const session = (id: string, deviceId = 'remote'): Session => ({ id, deviceId, nativeId: id, title: id, agent: 'codex', cwd: '/repo', updatedAt: '2026-10-10T00:00:00Z' });
const snapshotCollections = (data: TaskCenterData) => ({ ...data, devices: data.devices.filter(device => device.id !== 'local'), directoryRequests: data.directoryRequests || [], gitRequests: data.gitRequests || [], executions: data.executions || [] });

test('incremental replay coalesces changes, preserves unrelated tasks and removes deleted rows', async t => {
  const { database, center } = fixture(t);
  await center.command({ action: 'create', title: '保留任务' }, actor);
  const base = await center.snapshot();
  await center.command({ action: 'create', title: '新任务' }, actor);
  database.mutateTaskCenter('default', data => { data.sessions.push(session('temporary'), session('retained')); });
  database.mutateTaskCenter('default', data => { data.sessions = data.sessions.filter(item => item.id !== 'temporary'); data.sessions[0].title = '更新后的会话'; });
  const delta = await center.changes(base.syncVersion!);
  assert.equal(delta.reset, false);
  if (delta.reset) return;
  assert.equal(delta.changes.tasks?.upsert.length, 1);
  assert.deepEqual(delta.changes.sessions?.removed, ['temporary']);
  const updated = applyTaskCenterDelta(base, delta);
  assert.deepEqual(snapshotCollections(updated), snapshotCollections(await center.snapshot()));
  assert.throws(() => applyTaskCenterDelta(updated, delta), /版本不匹配/);
  assert.equal((await center.changes(updated.syncVersion!)).version, delta.version);
});

test('device heartbeats patch only the device and changed previews, never include preview bodies', async t => {
  const { center } = fixture(t);
  await center.command({ action: 'create', title: '不变的任务' }, actor);
  const base = await center.snapshot();
  const preview = { offset: 0, total: 1, sourcePartial: false, truncated: false, messages: [{ role: 'user', text: '正文不随快照传输' }] };
  const heartbeat = { action: 'heartbeat', deviceId: 'remote', name: '设备', agents: ['codex'], sessions: [{ nativeId: 'native', agent: 'codex', title: '历史', remoteHistory: preview }] };
  await center.command(heartbeat, actor);
  const delta = await center.changes(base.syncVersion!);
  assert.equal(delta.reset, false);
  if (delta.reset) return;
  assert.equal(delta.changes.tasks, undefined);
  assert.equal(delta.changes.executions, undefined);
  assert.equal(delta.changes.sessions?.upsert.length, 1);
  assert.equal(JSON.stringify(delta).includes('正文不随快照传输'), false);
  const version = delta.version;
  await center.command({ ...heartbeat, sessions: [] }, actor);
  const next = await center.changes(version);
  assert.equal(next.reset, false);
  if (next.reset) return;
  assert.equal(next.changedIds.sessions, undefined);
  assert.deepEqual(next.changes.sessions, { upsert: [], removed: [] });
});

test('changed preview content invalidates the session even when its small metadata stays identical', async t => {
  const { database, center } = fixture(t);
  database.mutateTaskCenter('default', data => { data.sessions.push(session('same')); });
  const base = await center.snapshot();
  database.mutateTaskCenter('default', () => database.setRemoteSessionHistory('default', 'same', { offset: 0, total: 1, sourcePartial: false, truncated: false, messages: [{ role: 'assistant', text: '正文变化' }] }));
  const delta = await center.changes(base.syncVersion!);
  assert.equal(delta.reset, false);
  if (!delta.reset) assert.deepEqual(delta.changedIds.sessions, ['same']);
});

test('managed sessions replace duplicate history rows and local discovery removes disappeared files', async t => {
  const { database, center, sessions } = fixture(t);
  sessions.push(session('local-file', 'local'));
  database.mutateTaskCenter('default', data => { data.sessions.push(session('imported')); });
  const base = await center.snapshot();
  sessions.splice(0, 1, session('new-local-file', 'local'));
  database.mutateTaskCenter('default', data => { data.sessions.push({ ...session('managed'), nativeId: 'imported', source: 'conversation' }); });
  const delta = await center.changes(base.syncVersion!);
  assert.equal(delta.reset, false);
  const updated = applyTaskCenterDelta(base, delta);
  assert.deepEqual(updated.sessions.map(item => item.id).sort(), ['managed', 'new-local-file']);
  assert.deepEqual(updated.sessions, (await center.snapshot()).sessions);
});

test('journal is tenant scoped, transactional and survives restart; missing history explicitly resets', async t => {
  const { key, database, center } = fixture(t);
  const notifications: number[] = [];
  database.subscribeTaskCenter('default', version => notifications.push(version));
  const { taskId } = await center.command({ action: 'create', title: '原任务' }, actor);
  await assert.rejects(center.command({ action: 'update', taskId, revision: 99, title: '失败', status: 'ready' }, actor), { statusCode: 409 });
  assert.deepEqual(notifications, [1]);
  assert.equal(database.readTaskCenterChanges('other', 0).version, 0);
  database.mutateTaskCenter('other', data => { data.sessions.push(session('private')); });
  const reopened = openDatabase(key);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.readTaskCenterChanges('default', 0).changes.tasks, [taskId]);
  assert.equal(JSON.stringify(reopened.readTaskCenterChanges('default', 0)).includes('private'), false);
  const raw = rawDatabase(key);
  raw.prepare('DELETE FROM task_center_changes WHERE tenant_id = ?').run('default'); raw.close();
  const reset = await center.changes(0);
  assert.equal(reset.reset, true);
  assert.equal(applyTaskCenterDelta({ tasks: [], devices: [], sessions: [], handoffs: [], executions: [], syncVersion: 0 }, reset).tasks[0].id, taskId);
  assert.equal((await center.changes(999)).reset, true);
});

test('competing task revisions commit one patch and failed batches leave no journal or stale history invalidation', async t => {
  const { database, center } = fixture(t);
  const { taskId } = await center.command({ action: 'create', title: '竞争任务' }, actor);
  const base = await center.snapshot();
  const results = await Promise.allSettled(['first', 'second'].map(title => center.command({ action: 'update', taskId, title, revision: 1, status: 'ready' }, actor)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(database.readTaskCenter('default').syncVersion, base.syncVersion! + 1);
  const version = database.readTaskCenter('default').syncVersion!;
  assert.throws(() => database.mutateTaskCenter('default', data => {
    data.sessions.push(session('rolled-back'));
    database.setRemoteSessionHistory('default', 'rolled-back', { offset: 0, total: 0, sourcePartial: false, truncated: false, messages: [] });
    throw new Error('abort-batch');
  }), /abort-batch/);
  assert.equal(database.readTaskCenter('default').syncVersion, version);
  assert.equal(database.readRemoteSessionHistory('default', 'rolled-back'), null);
  database.mutateTaskCenter('default', () => {});
  assert.deepEqual(database.readTaskCenterChanges('default', version).changes, {});
});

test('change history is bounded and an expired cursor receives a complete authoritative snapshot', async t => {
  const { key, database, center } = fixture(t);
  for (let i = 0; i < 257; i++) database.mutateTaskCenter('default', () => {});
  const raw = rawDatabase(key);
  assert.equal(Number(raw.prepare('SELECT count(*) AS count FROM task_center_changes WHERE tenant_id = ?').get('default')?.count), 256); raw.close();
  assert.equal((await center.changes(0)).reset, true);
  assert.equal((await center.changes(1)).reset, false);
});

test('changes API enforces authentication, cursor validation, tenant isolation and releases live streams on shutdown', async t => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'task-sync-http-'));
  const app = createApp({ rootDir, environment: { ACP_ENABLED: 'false', CODEX_EXECUTABLE: '/missing/codex', IDE_HISTORY_CODEX_DIR: path.join(rootDir, 'none'), IDE_HISTORY_CLAUDE_DIR: path.join(rootDir, 'none') } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let closed = false;
  t.after(async () => { if (!closed) await app.close(); await rm(rootDir, { recursive: true, force: true }); });
  const address = app.server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const register = async (username: string) => {
    const response = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'test-password-for-sync' }) });
    assert.equal(response.status, 201);
    return await response.json() as { token: string };
  };
  const a = await register('first'), b = await register('second');
  const headers = { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/task-center/changes?since=0')).status, 401);
  for (const suffix of ['-1', '1.5', 'no', '9007199254740992', '1e2', '', '0&since=1']) {
    const response = await fetch(base + '/api/task-center/changes?since=' + suffix, { headers });
    assert.equal(response.status, 400, suffix);
  }
  await fetch(base + '/api/task-center', { method: 'POST', headers, body: JSON.stringify({ action: 'create', title: 'first-only' }) });
  const response = await fetch(base + '/api/task-center/changes?since=0', { headers });
  assert.equal(response.status, 200);
  const delta = await response.json() as TaskCenterDelta;
  assert.equal(delta.reset, false);
  if (!delta.reset) assert.equal(delta.changes.tasks?.upsert[0].title, 'first-only');
  const other = await fetch(base + '/api/task-center/changes?since=0', { headers: { Authorization: `Bearer ${b.token}` } });
  assert.equal((await other.text()).includes('first-only'), false);
  const abort = new AbortController();
  const stream = await fetch(base + '/api/task-center/updates?since=0', { headers, signal: abort.signal });
  const reader = stream.body!.getReader();
  assert.ok(new TextDecoder().decode((await reader.read()).value).includes(`"version":${delta.version}`));
  const next = reader.read();
  await app.close(); closed = true;
  assert.equal((await next).done, true);
  abort.abort();
});
