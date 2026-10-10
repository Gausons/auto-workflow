import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, openDatabase } from '../scripts/testing/database.js';
import type { Execution, TaskCenterData } from '../shared/taskTypes.js';

test('device state and notifications enforce authorization and isolate control changes', { timeout: 20_000 }, async t => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'device-control-'));
  const app = createApp({ rootDir, environment: { DEFAULT_TENANT_TOKEN: 'test-setup-token-'.repeat(3), ACP_ENABLED: 'false',
    CODEX_EXECUTABLE: path.join(rootDir, 'unavailable-codex'), IDE_HISTORY_CODEX_DIR: path.join(rootDir, 'missing-codex'), IDE_HISTORY_CLAUDE_DIR: path.join(rootDir, 'missing-claude') } });
  const db = openDatabase(rootDir);
  let closed = false;
  t.after(async () => { if (!closed) await app.close(); db.close(); await rm(rootDir, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`, password = 'device-control-test-password';
  const owner = await db.createUser('default', { username: 'owner', password }, { bootstrap: true });
  const connector = await db.createUser('default', { username: 'connector', password, role: 'operator' }, { actor: owner });
  await db.createUser('default', { username: 'viewer', password, role: 'viewer' }, { actor: owner });
  db.createTenant({ id: 'other', token: 'other-tenant-token-'.repeat(3) });
  await db.createUser('other', { username: 'other', password }, { bootstrap: true });
  const tokens = { owner: (await db.login('default', 'owner', password)).token, connector: (await db.login('default', 'connector', password)).token,
    viewer: (await db.login('default', 'viewer', password)).token, other: (await db.login('other', 'other', password)).token };
  const fetchApi = (endpoint: string, token?: string, signal?: AbortSignal) => fetch(base + endpoint, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal });
  const notify = async () => {
    const response = await fetch(base + '/api/task-center', { method: 'POST', headers: { Authorization: `Bearer ${tokens.owner}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', title: '触发控制状态核对' }) });
    assert.equal(response.status, 200); await response.json();
  };
  const seed = (deviceId: string): Execution => ({ id: randomUUID(), deviceId, taskId: 'task', contextVersion: 1, cwd: rootDir,
    title: '远端执行', prompt: 'test', status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const job = seed('remote'), unrelated = seed('another-device');
  db.mutateTaskCenter('default', data => {
    data.devices.push({ id: 'remote', owner: connector.id, name: '开发机', agents: ['codex'], lastSeen: new Date().toISOString(), transport: 'connector' });
    data.executions = [job, unrelated];
  });
  for (const route of ['device-state', 'device-updates']) {
    const endpoint = `/api/task-center/${route}?deviceId=remote`;
    for (const [token, status] of [[undefined, 401], [tokens.viewer, 403], [tokens.owner, 403], [tokens.other, 404]] as const) {
      const response = await fetchApi(endpoint, token); assert.equal(response.status, status); await response.json();
    }
    for (const params of ['', '?deviceId=local', '?deviceId=../remote', '?deviceId=remote&deviceId=remote']) {
      const response = await fetchApi(`/api/task-center/${route}${params}`, tokens.connector); assert.equal(response.status, 400); await response.json();
    }
  }
  const state = await (await fetchApi('/api/task-center/device-state?deviceId=remote', tokens.connector)).json() as TaskCenterData;
  assert.deepEqual(state.executions.map(item => item.id), [job.id]);
  assert.deepEqual(state.tasks, []); assert.deepEqual(state.sessions, []); assert.equal(state.devices.length, 1);
  const abort = new AbortController(); t.after(() => abort.abort());
  const stream = await fetchApi('/api/task-center/device-updates?deviceId=remote', tokens.connector, abort.signal);
  assert.equal(stream.status, 200); assert.equal(stream.headers.get('x-accel-buffering'), 'no');
  const reader = stream.body!.getReader(), decoder = new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value), /event: device-control/);
  let notified = false;
  const next = reader.read().then(result => { notified = true; return result; });
  db.mutateTaskCenter('default', data => {
    data.devices[0].lastSeen = new Date().toISOString();
    data.executions[0].output = '新输出'; data.executions[1].control = { id: randomUUID(), action: 'stop' };
  });
  await notify();
  await delay(20); assert.equal(notified, false, 'heartbeats, output and another device must not generate control wakeups');
  db.mutateTaskCenter('default', data => { data.executions[0].control = { id: randomUUID(), action: 'stop' }; });
  await notify();
  const frame = decoder.decode((await next).value);
  assert.match(frame, /event: device-control/); assert.doesNotMatch(frame, /prompt|新输出|stop/);
  // A connected stream also follows revocation before publishing another hint.
  db.updateUser('default', connector.id, { enabled: false }, owner);
  db.mutateTaskCenter('default', data => { data.executions[0].control = null; });
  await notify();
  assert.equal((await reader.read()).done, true);
  const revoked = await fetchApi('/api/task-center/device-state?deviceId=remote', tokens.connector);
  assert.equal(revoked.status, 401); await revoked.json(); reader.releaseLock();
  // Keep an authorized stream open during shutdown: server.close must release it.
  db.updateUser('default', connector.id, { enabled: true }, owner);
  const renewed = (await db.login('default', 'connector', password)).token;
  const live = await fetchApi('/api/task-center/device-updates?deviceId=remote', renewed);
  const liveReader = live.body!.getReader(); await liveReader.read();
  await app.close(); closed = true;
  assert.equal((await liveReader.read()).done, true); liveReader.releaseLock();
});
