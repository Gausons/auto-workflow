import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodexExecution } from '../src/codexExecution.js';
import { createTaskCenter } from '../src/taskCenter.js';
import { openDatabase } from '../scripts/testing/database.js';
import { RemoteCodexWorker } from '../src/remoteCodexWorker.js';
import { remoteContinuationProject } from '../src/remoteSession.js';

type Service = ReturnType<typeof createCodexExecution>;
type Options = ConstructorParameters<typeof RemoteCodexWorker>[0];
type Report = Parameters<Parameters<NonNullable<Options['runnerFactory']>>[0]>[0];

async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-continuation-'));
  const db = openDatabase();
  db.createTenant({ id: 'default', token: 'x'.repeat(32) });
  db.createTenant({ id: 'other', token: 'y'.repeat(32) });
  const owner = { id: 'connector-owner' }, nativeId = randomUUID();
  const center = createTaskCenter({ database: db, tenantId: 'default', history: { catalog: async () => ({ sessions: [], providers: [] }) } });
  const heartbeat = { action: 'heartbeat', deviceId: 'remote', name: '开发机', agents: ['codex'], capabilities: { resumeCodex: true },
    sessions: [{ nativeId, agent: 'codex', title: '原会话', cwd: root }], codexProjects: [{ id: 'p', name: '项目', agent: 'codex', cwd: root }] };
  await center.command(heartbeat, owner);
  const session = db.readTaskCenter('default').sessions[0]!;
  const service = createCodexExecution({ database: db, tenantId: 'default', workspace: () => root, runnerFactory: () => ({ projects: async () => [], start() { assert.fail('must not execute on server'); }, close() {} }) });
  const started: Report[] = [], responses: string[] = [];
  let update: (job: Report) => void = () => {};
  let invalidSource = false;
  const workerOptions: Options = { deviceId: 'remote', workspace: root, directory: path.join(root, 'journal'),
    contextSource: { catalog: async () => ({ sessions: invalidSource ? [] : [{ id: session.id, sessionId: nativeId, agent: 'codex', cwd: root }] }), delivery: { detail: async () => { throw new Error('unused'); }, record: async () => { throw new Error('should not read transcript for native resume'); } } },
    request: (method, body) => method === 'GET' ? center.snapshot() : service.action(body as Parameters<Service['action']>[0], owner),
    runnerFactory: callback => {
      update = callback;
      return { projects: async () => heartbeat.codexProjects, start(job: Report) { started.push(job); callback({ ...job, threadId: nativeId, status: 'running' }); },
        async respond(id: string) { responses.push(id); }, async stop(id: string) { callback({ ...started.find(job => job.id === id)!, threadId: nativeId, status: 'interrupted' }); }, async reconcile() {}, close() {} };
    } };
  const workers: RemoteCodexWorker[] = [];
  const worker = () => { const value = new RemoteCodexWorker(workerOptions); workers.push(value); return value; };
  t.after(async () => { workers.forEach(item => item.close()); service.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, db, owner, nativeId, center, heartbeat, session, service, started, responses, worker, workerOptions, update: (job: Report) => update(job), invalidateSource: () => { invalidSource = true; } };
}

test('remote original-session sends are tenant-scoped, idempotent and mutually exclusive', async t => {
  const f = await fixture(t), input = { requestId: randomUUID(), message: '继续检查' };
  const [first, duplicate] = await Promise.all([f.service.continueHistory(f.session.id, input), f.service.continueHistory(f.session.id, input)]);
  assert.deepEqual(first, duplicate);
  assert.equal(f.db.readTaskCenter('default').executions.length, 1);
  await assert.rejects(f.service.continueHistory(f.session.id, { ...input, message: '不同指令' }), { statusCode: 409 });
  await assert.rejects(f.service.continueHistory(f.session.id, { ...input, requestId: randomUUID() }), { statusCode: 409 });
  await assert.rejects(f.service.action({ action: 'claim', executionId: first.executionId }, { id: 'other-owner' }), { statusCode: 403 });
  const other = createCodexExecution({ database: f.db, tenantId: 'other', workspace: () => f.root, history: { detail: async () => { throw Object.assign(new Error('not found'), { statusCode: 404 }); }, resolveSource: async () => { throw Object.assign(new Error('not found'), { statusCode: 404 }); } }, runnerFactory: () => ({ close() {} }) });
  t.after(() => other.close());
  await assert.rejects(other.continueHistory(f.session.id, input), { statusCode: 404 });
  await assert.rejects(other.historyExecution(f.session.id), { statusCode: 404 });
  const worker = f.worker();
  await Promise.all([worker.sync(), worker.sync()]);
  assert.equal(f.started.length, 1);
  assert.equal(f.started[0]?.resumeThreadId, f.nativeId);
  assert.equal(f.started[0]?.protocol, 'legacy');
  await assert.rejects(f.service.action({ action: 'report', executionId: first.executionId, report: { status: 'running', threadId: randomUUID() } }, f.owner), { statusCode: 409 });
  f.update({ ...f.started[0]!, threadId: f.nativeId, status: 'waiting', request: { method: 'item/commandExecution/requestApproval', params: { command: 'test' } } });
  await worker.sync();
  await f.service.action({ action: 'respond', executionId: first.executionId, decision: 'decline' });
  await worker.sync(); await worker.sync();
  assert.equal(f.responses.length, 1);
  await f.service.action({ action: 'stop', executionId: first.executionId });
  await worker.sync();
  assert.equal((await f.service.historyExecution(f.session.id)).execution?.status, 'interrupted');
  await f.service.continueHistory(f.session.id, { requestId: randomUUID(), message: '下一轮' });
  await worker.sync();
  assert.equal(f.started.length, 2);
  assert.equal(f.started[1]?.resumeThreadId, f.nativeId);
});

test('old, sync-only and archived devices cannot expose native resume', async t => {
  const f = await fixture(t);
  assert.ok(remoteContinuationProject(f.db.readTaskCenter('default'), f.session));
  for (const heartbeat of [{ ...f.heartbeat, capabilities: undefined }, { ...f.heartbeat, codexProjects: [] }, { ...f.heartbeat, sessions: [{ ...f.heartbeat.sessions[0], archived: true }] }]) {
    await f.center.command(heartbeat, f.owner);
    const data = f.db.readTaskCenter('default');
    assert.equal(remoteContinuationProject(data, data.sessions[0]!), undefined);
    await assert.rejects(f.service.continueHistory(f.session.id, { requestId: randomUUID(), message: '继续' }), { statusCode: 409 });
  }
});

test('missing native history fails before execution and does not block later syncs', async t => {
  const f = await fixture(t);
  await f.service.continueHistory(f.session.id, { requestId: randomUUID(), message: '继续' });
  f.invalidateSource();
  const worker = f.worker(); await worker.sync(); await worker.sync();
  assert.equal(f.started.length, 0);
  assert.equal((await f.service.historyExecution(f.session.id)).execution?.status, 'failed');
  assert.match((await f.service.historyExecution(f.session.id)).execution?.message || '', /原会话不存在/);
});

test('restart preserves unknown execution and does not repeat an uncertain approval', async t => {
  const f = await fixture(t);
  const { executionId } = await f.service.continueHistory(f.session.id, { requestId: randomUUID(), message: '继续' });
  const worker = f.worker(); await worker.sync();
  f.update({ ...f.started[0]!, threadId: f.nativeId, status: 'waiting', request: { method: 'permission' } }); await worker.sync();
  await f.service.action({ action: 'respond', executionId, decision: 'accept' });
  // Model a process crash after durable receipt but before final state/report.
  worker.runner.respond = async () => { throw new Error('connection lost'); };
  const request = worker.request;
  worker.request = (method, body, endpoint) => { if (method === 'POST') throw new Error('offline'); return request(method, body, endpoint); };
  await assert.rejects(worker.sync(), /offline/);
  const receipt = JSON.parse(await readFile(path.join(f.root, 'journal', `control-${executionId}.json`), 'utf8')) as { id: string };
  assert.ok(receipt.id);
  // A crash can leave the old execution journal even though receipt is durable.
  await writeFile(path.join(f.root, 'journal', `${executionId}.json`), JSON.stringify({ ...f.started[0], status: 'waiting', threadId: f.nativeId }));
  worker.close();
  const restarted = f.worker(); await restarted.sync();
  assert.equal(f.started.length, 1); assert.equal(f.responses.length, 0);
  const job = (await f.service.historyExecution(f.session.id)).execution;
  assert.equal(job?.status, 'unknown'); assert.equal(job?.control, null);
  assert.match(job?.controlError || '', /不会自动重复提交/);
});

test('graceful connector shutdown publishes unknown without restarting the agent', async t => {
  const f = await fixture(t);
  await f.service.continueHistory(f.session.id, { requestId: randomUUID(), message: '继续' });
  const worker = f.worker(); await worker.sync(); await worker.shutdown();
  assert.equal((await f.service.historyExecution(f.session.id)).execution?.status, 'unknown');
  const restarted = f.worker(); await restarted.sync(); assert.equal(f.started.length, 1);
});


test('device journal binding rejects cross-server, tenant and user reuse', async t => {
  const { bindDeviceConnection } = await import('../src/deviceConnectionIdentity.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'device-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = { origin: 'https://workbench.example.com', tenantId: 'team', userId: 'owner' };
  await bindDeviceConnection(root, identity); await bindDeviceConnection(root, identity);
  for (const changed of [{ ...identity, origin: 'https://other.example.com' }, { ...identity, tenantId: 'other' }, { ...identity, userId: 'other' }]) {
    await assert.rejects(bindDeviceConnection(root, changed), /状态目录属于其他/);
  }
});


test('connector rejects a forged working directory and a changed native history directory', async t => {
  for (const change of ['project', 'history']) await t.test(change, async child => {
    const f = await fixture(child);
    const { executionId } = await f.service.continueHistory(f.session.id, { requestId: randomUUID(), message: '继续' });
    if (change === 'project') f.db.mutateTaskCenter('default', data => { data.executions.find(job => job.id === executionId)!.cwd = path.dirname(f.root); });
    else f.workerOptions.contextSource!.catalog = async () => ({ sessions: [{ id: f.session.id, sessionId: f.nativeId, agent: 'codex', cwd: path.dirname(f.root) }] });
    await f.worker().sync();
    assert.equal(f.started.length, 0);
    assert.equal((await f.service.historyExecution(f.session.id)).execution?.status, 'failed');
  });
});
