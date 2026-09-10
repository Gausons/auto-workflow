import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexRunner, createCodexExecution } from '../src/codexExecution.mjs';
import { createTaskCenter } from '../src/taskCenter.mjs';
import { openDatabase } from '../src/database.mjs';

class FakeClient extends EventEmitter {
  calls = []; closed = false;
  async initialize() { return this; }
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: '12345678-1234-1234-1234-123456789abc' } };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    if (method === 'thread/read') return { thread: { turns: [{ id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text: 'done' }] }] } };
    return {};
  }
  send(message) { this.calls.push(message); }
  close() { this.closed = true; this.emit('disconnected', new Error('closed')); }
}
const job = () => ({ id: 'job-1', taskId: 'task-1', title: '任务', prompt: '实现功能', cwd: '/repo', projectId: 'project-1', status: 'queued' });

test('creates durable project thread, starts a real turn and opens desktop without overriding permissions/model', async () => {
  const client = new FakeClient(), updates = [], opened = [];
  const runner = new CodexRunner({ clientFactory: () => client, onUpdate: j => updates.push(j), desktopOpener: async id => opened.push(id) });
  await runner.start(job()); await runner.start(job());
  const starts = client.calls.filter(c => c.method === 'thread/start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.ephemeral, false);
  assert.equal(starts[0].params.projectId, 'project-1');
  assert.equal(starts[0].params.approvalPolicy, undefined);
  assert.equal(starts[0].params.model, undefined);
  assert.deepEqual(opened, ['12345678-1234-1234-1234-123456789abc']);
  assert.equal(updates.at(-1).status, 'running');
  client.emit('notification', { method: 'item/completed', params: { threadId: opened[0], item: { type: 'agentMessage', text: '验证通过' } } });
  client.emit('notification', { method: 'turn/completed', params: { threadId: opened[0], turn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(updates.at(-1).status, 'completed'); assert.equal(updates.at(-1).output, '验证通过');
  runner.close(); assert.equal(updates.at(-1).status, 'completed');
});

test('approval and input require an explicit answer; stop uses native turn interrupt', async () => {
  const client = new FakeClient(), updates = [];
  const runner = new CodexRunner({ clientFactory: () => client, onUpdate: j => updates.push(j), desktopOpener: async () => {} });
  await runner.start(job()); const threadId = updates.at(-1).threadId;
  client.emit('request', { id: 42, method: 'item/commandExecution/requestApproval', params: { threadId, command: 'npm test' } });
  assert.equal(updates.at(-1).status, 'waiting'); assert.ok(!client.calls.some(c => c.id === 42));
  await assert.rejects(runner.respond('job-1', { decision: 'acceptForSession' }), { statusCode: 400 });
  await runner.respond('job-1', { decision: 'decline' });
  assert.deepEqual(client.calls.at(-1), { id: 42, result: { decision: 'decline' } });
  client.emit('request', { id: 43, method: 'item/tool/requestUserInput', params: { threadId, questions: [{ id: 'q', question: '怎么处理？' }] } });
  await assert.rejects(runner.respond('job-1', { answers: {} }), { statusCode: 400 });
  await runner.respond('job-1', { answers: { q: '继续测试' } });
  assert.deepEqual(client.calls.at(-1).result, { answers: { q: { answers: ['继续测试'] } } });
  await runner.stop('job-1'); assert.equal(client.calls.at(-1).method, 'turn/interrupt'); runner.close();
});

test('uncertain create and disconnected runs never automatically rerun', async () => {
  const client = new FakeClient(), updates = [];
  client.call = async method => { if (method === 'thread/start') throw new Error('timeout'); return {}; };
  const runner = new CodexRunner({ clientFactory: () => client, onUpdate: j => updates.push(j), desktopOpener: async () => {} });
  await runner.start(job()); assert.equal(updates.at(-1).status, 'unknown');
  assert.equal(updates.at(-1).threadId, undefined); runner.close();
});

test('durable execution reservations isolate tenants, reject duplicates, and recover restart as unknown', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-execution-')); t.after(() => rm(root, { recursive: true, force: true }));
  const db = openDatabase(':memory:'); t.after(() => db.close());
  db.createTenant({ id: 'default', token: 'x'.repeat(32) }); db.createTenant({ id: 'other', token: 'y'.repeat(32) });
  const history = { catalog: async () => ({ sessions: [], providers: [] }) };
  const center = createTaskCenter({ database: db, tenantId: 'default', history });
  await center.command({ action: 'create', title: '测试执行' }, { id: 'owner' });
  const task = (await center.snapshot()).tasks[0];
  let update, started = 0;
  const factory = fn => { update = fn; return { projects: async () => [{ id: 'project-1', name: 'Repo', cwd: root }], start: async j => { started++; fn({ ...j, threadId: '12345678-1234-1234-1234-123456789abc', status: 'running', message: 'running' }); }, close() {} }; };
  const service = createCodexExecution({ database: db, tenantId: 'default', workspace: () => root, runnerFactory: factory });
  const input = { taskId: task.id, revision: task.revision, projectId: 'project-1', cwd: root };
  await assert.rejects(service.execute({ ...input, cwd: '/outside' }), { statusCode: 400 });
  const result = await service.execute(input); assert.equal(started, 1);
  await assert.rejects(service.execute(input), { statusCode: 409 });
  const snapshot = await center.snapshot(); assert.equal(snapshot.tasks[0].status, 'running'); assert.equal(snapshot.tasks[0].sessionIds.length, 1);
  assert.equal(snapshot.sessions.length, 1); assert.equal(db.readTaskCenter('other').executions, undefined);
  await assert.rejects(service.action({ executionId: 'other-id', action: 'stop' }), { statusCode: 404 });
  update({ ...db.readTaskCenter('default').executions[0], status: 'completed', message: 'completed', output: 'ok' });
  assert.equal((await center.snapshot()).tasks[0].status, 'completed');
  const latest = (await center.snapshot()).tasks[0];
  await service.execute({ ...input, revision: latest.revision }); service.close();
  const restarted = createCodexExecution({ database: db, tenantId: 'default', workspace: () => root, runnerFactory: factory });
  assert.equal(db.readTaskCenter('default').executions.at(-1).status, 'unknown');
  await assert.rejects(restarted.execute({ ...input, revision: (await center.snapshot()).tasks[0].revision }), { statusCode: 409 });
  assert.equal(started, 2); assert.ok(result.executionId); restarted.close();
});
