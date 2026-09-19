import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexRunner, createCodexExecution } from '../src/codexExecution.js';
import { createTaskCenter } from '../src/taskCenter.js';
import { openDatabase } from '../src/database.js';

class FakeClient extends EventEmitter {
  calls: any[] = []; closed = false;
  async initialize() { return this; }
  async call(method: any, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: '12345678-1234-1234-1234-123456789abc' } };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    if (method === 'thread/read') return { thread: { turns: [{ id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text: 'done' }] }] } };
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
    return {};
  }
  send(message: any) { this.calls.push(message); }
  close() { this.closed = true; this.emit('disconnected', new Error('closed')); }
}
const job = () => ({ id: 'job-1', taskId: 'task-1', title: '任务', prompt: '实现功能', cwd: '/repo', projectId: 'project-1', status: 'queued' });

test('creates durable project thread, starts a real turn and opens desktop without overriding permissions/model', async () => {
  const client = new FakeClient(), updates: any = [], opened: any = [];
  const originalCall = client.call.bind(client);
  client.call = async (method: any, params: any) => {
    if (method === 'thread/name/set') throw Object.assign(new Error('thread metadata update is not supported'), { code: -32601 });
    return originalCall(method, params);
  };
  const runner = new CodexRunner({ clientFactory: () => client, onUpdate: (j: any) => updates.push(j), desktopOpener: async (id: any) => opened.push(id) });
  await runner.start(job()); await runner.start(job());
  const starts = client.calls.filter((c: any) => c.method === 'thread/start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.params.ephemeral, false);
  assert.equal(starts[0]!.params.projectId, 'project-1');
  assert.equal(starts[0]!.params.approvalPolicy, undefined);
  assert.equal(starts[0]!.params.model, undefined);
  assert.deepEqual(opened, ['12345678-1234-1234-1234-123456789abc']);
  assert.equal(updates.at(-1).status, 'running');
  await runner.notification({ method: 'item/completed', params: { threadId: opened[0], item: { type: 'agentMessage', text: '验证通过' } } });
  await runner.notification({ method: 'turn/completed', params: { threadId: opened[0], turn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(updates.at(-1).status, 'completed'); assert.equal(updates.at(-1).output, '验证通过');
  assert.deepEqual(client.calls.at(-1), { method: 'thread/unsubscribe', params: { threadId: opened[0] } });
  assert.equal(updates.at(-1).subscriptionStatus, 'unsubscribed');
  runner.close(); assert.equal(updates.at(-1).status, 'completed');
});

test('passes an explicitly selected model and reasoning effort to Codex', async () => {
  const client = new FakeClient();
  const runner = new CodexRunner({ clientFactory: () => client, desktopOpener: async () => {} });
  await runner.start({ ...job(), model: 'gpt-test', reasoningEffort: 'high' });
  const start = client.calls.find((call: any) => call.method === 'thread/start');
  assert.equal(start.params.model, 'gpt-test');
  assert.deepEqual(start.params.config, { model_reasoning_effort: 'high' });
  runner.close();
})
test('terminal failures keep their execution result when releasing the desktop subscription fails', async () => {
  const client = new FakeClient(), updates: any[] = [];
  const originalCall = client.call.bind(client);
  client.call = async (method, params) => {
    if (method === 'thread/unsubscribe') { client.calls.push({ method, params }); throw new Error('connection lost'); }
    return originalCall(method, params);
  };
  const runner = new CodexRunner({ clientFactory: () => client, onUpdate: (j: any) => updates.push(j), desktopOpener: async () => {} });
  await runner.start(job());
  await runner.notification({ method: 'turn/completed', params: { threadId: updates.at(-1).threadId, turn: { id: 'turn-1', status: 'failed', error: { message: 'tests failed' } } } });
  assert.equal(updates.at(-1).status, 'failed');
  assert.equal(updates.at(-1).message, 'tests failed');
  assert.equal(updates.at(-1).releaseError, 'connection lost');
});

test('reconciliation releases a completed thread subscription', async () => {
  const client = new FakeClient(), updates: any[] = [];
  const runner = new CodexRunner({ clientFactory: () => client, onUpdate: (j: any) => updates.push(j), desktopOpener: async () => {} });
  const saved: any = job(); saved.threadId = '12345678-1234-1234-1234-123456789abc'; saved.turnId = 'turn-1'; saved.status = 'unknown';
  await runner.reconcile(saved);
  assert.equal(updates.at(-1).status, 'completed');
  assert.equal(updates.at(-1).subscriptionStatus, 'unsubscribed');
  assert.deepEqual(client.calls.slice(-2).map(call => call.method), ['thread/read', 'thread/unsubscribe']);
});

test('approval and input require an explicit answer; stop uses native turn interrupt', async () => {
  const client = new FakeClient(), updates: any = [];
  const runner = new CodexRunner({ clientFactory: () => client, onUpdate: (j: any) => updates.push(j), desktopOpener: async () => {} });
  await runner.start(job()); const threadId: any = updates.at(-1).threadId;
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
  const client = new FakeClient(), updates: any = [];
  client.call = async method => { if (method === 'thread/start') throw new Error('timeout'); return {}; };
  const runner = new CodexRunner({ clientFactory: () => client, onUpdate: (j: any) => updates.push(j), desktopOpener: async () => {} });
  await runner.start(job()); assert.equal(updates.at(-1).status, 'unknown');
  assert.equal(updates.at(-1).threadId, undefined); runner.close();
});

test('uses the configured workspace when newer Codex removes project/list', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-workspace-target-')); t.after(() => rm(root, { recursive: true, force: true }));
  const client = new FakeClient();
  const originalCall = client.call.bind(client);
  client.call = async (method: any, params: any) => {
    if (method === 'project/list') throw Object.assign(new Error('Method not found: project/list. Supported methods: thread/start'), { code: -32601 });
    return originalCall(method, params);
  };
  const runner = new CodexRunner({ clientFactory: () => client, desktopOpener: async () => {} });
  const targets = await runner.projects(root);
  assert.equal(targets.length, 1); assert.equal(targets[0].cwd, await realpath(root)); assert.equal(targets[0].appServerProjectId, null);
  await runner.start({ ...job(), id: 'workspace-job', cwd: targets[0].cwd, projectId: targets[0].id, appServerProjectId: null });
  const start = client.calls.find((call: any) => call.method === 'thread/start');
  assert.equal(start.params.cwd, targets[0].cwd); assert.equal(start.params.projectId, undefined);
  runner.close();
});

test('durable execution reservations isolate tenants, reject duplicates, and recover restart as unknown', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-execution-')); t.after(() => rm(root, { recursive: true, force: true }));
  const alternative = path.join(root, 'another-project'); await mkdir(alternative);
  const db = openDatabase(':memory:'); t.after(() => db.close());
  db.createTenant({ id: 'default', token: 'x'.repeat(32) }); db.createTenant({ id: 'other', token: 'y'.repeat(32) });
  const history: any = { catalog: async () => ({ sessions: [], providers: [] }) };
  const center = createTaskCenter({ database: db, tenantId: 'default', history });
  await center.command({ action: 'create', title: '测试执行' }, { id: 'owner' });
  const task = (await center.snapshot()).tasks[0];
  let update: any, started = 0;
  const factory = (fn: any) => { update = fn; return { projects: async () => [{ id: 'project-1', name: 'Repo', cwd: root, models: [{ id: 'model-1', name: 'Model 1', reasoningEfforts: [{ id: 'high', name: 'High' }] }] }], start: async (j: any) => { started++; fn({ ...j, threadId: '12345678-1234-1234-1234-123456789abc', status: 'running', message: 'running' }); }, close() {} }; };
  const service = createCodexExecution({ database: db, tenantId: 'default', workspace: () => root, runnerFactory: factory, directoryPicker: async () => alternative });
  const input: any = { taskId: task.id, revision: task.revision, projectId: 'project-1', cwd: root };
  await assert.rejects(service.execute({ ...input, cwd: '/outside' }), { statusCode: 400 });
  assert.deepEqual(await service.pickDirectory({ deviceId: 'local', projectId: 'project-1' }, { id: 'owner' }), { status: 'completed', cwd: alternative });
  const result = await service.execute({ ...input, cwd: '' }); assert.equal(started, 1);
  assert.equal(db.readTaskCenter('default').executions[0].cwd, await realpath(root), 'blank cwd uses the target default');
  await assert.rejects(service.execute(input), { statusCode: 409 });
  const snapshot = await center.snapshot(); assert.equal(snapshot.tasks[0].status, 'running'); assert.equal(snapshot.tasks[0].sessionIds.length, 1);
  assert.equal(snapshot.sessions.length, 1); assert.equal(db.readTaskCenter('other').executions, undefined);
  await assert.rejects(service.action({ executionId: 'other-id', action: 'stop' }), { statusCode: 404 });
  update({ ...db.readTaskCenter('default').executions[0], status: 'completed', message: 'completed', output: 'ok' });
  assert.equal((await center.snapshot()).tasks[0].status, 'review');
  const latest = (await center.snapshot()).tasks[0];
  await service.execute({ ...input, revision: latest.revision, cwd: alternative, model: 'model-1', reasoningEffort: 'high', sourceSessionId: latest.sessionIds[0], instruction: '补充回归验证' });
  assert.equal(db.readTaskCenter('default').executions.at(-1).cwd, await realpath(alternative), 'an arbitrary accessible cwd is accepted');
  assert.match(db.readTaskCenter('default').executions.at(-1).prompt, /补充回归验证/);
  assert.match(db.readTaskCenter('default').executions.at(-1).prompt, /历史参考材料/);
  assert.equal(db.readTaskCenter('default').executions.at(-1).sourceSessionId, latest.sessionIds[0]);
  assert.equal(db.readTaskCenter('default').executions.at(-1).model, 'model-1');
  assert.equal(db.readTaskCenter('default').executions.at(-1).reasoningEffort, 'high');
  assert.ok((await service.targets()).projects[0].commonDirectories.includes(await realpath(alternative)));
  update({ ...db.readTaskCenter('default').executions[0], status: 'completed', desktopOpened: true });
  assert.equal((await center.snapshot()).tasks[0].status, 'running', 'late updates from an old run must not overwrite the newer run');
  service.close();
  const restarted = createCodexExecution({ database: db, tenantId: 'default', workspace: () => root, runnerFactory: factory });
  assert.equal(db.readTaskCenter('default').executions.at(-1).status, 'unknown');
  await assert.rejects(restarted.execute({ ...input, revision: (await center.snapshot()).tasks[0].revision }), { statusCode: 409 });
  assert.equal(started, 2); assert.ok(result.executionId); restarted.close();
});

test('remote device claims once, reports real thread state, and rejects other device accounts', async t => {
  const { RemoteCodexWorker } = await import('../src/remoteCodexWorker.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-codex-')); t.after(() => rm(root, { recursive: true, force: true }));
  const db = openDatabase(':memory:'); t.after(() => db.close()); db.createTenant({ id: 'default', token: 'x'.repeat(32) });
  const center = createTaskCenter({ database: db, tenantId: 'default', history: { catalog: async () => ({ sessions: [], providers: [] }) } });
  const owner: any = { id: 'device-owner' };
  await center.command({ action: 'heartbeat', deviceId: 'remote', name: 'Remote Mac', agents: ['codex'], sessions: [], codexProjects: [{ id: 'p', name: 'Repo', cwd: root }] }, owner);
  await center.command({ action: 'create', title: '远端执行' }, owner);
  const service = createCodexExecution({ database: db, tenantId: 'default', workspace: () => root, runnerFactory: () => ({ projects: async () => [], close() {} }) });
  t.after(() => service.close());
  const task = (await center.snapshot()).tasks[0];
  const { executionId } = await service.execute({ taskId: task.id, revision: task.revision, deviceId: 'remote', projectId: 'p', cwd: root });
  const selection = await service.pickDirectory({ deviceId: 'remote', projectId: 'p' }, { id: 'requester' });
  assert.equal(db.readTaskCenter('default').executions[0].status, 'queued');
  await assert.rejects(service.action({ action: 'claim', executionId }, { id: 'other' }), { statusCode: 403 });
  const client = new FakeClient(); let runner: any;
  const worker = new RemoteCodexWorker({ deviceId: 'remote', workspace: root, directory: path.join(root, 'journal'), directoryPicker: async () => root, request: (method: any, body: any, endpoint: any) => method === 'GET' ? center.snapshot() : endpoint === '/api/task-center/directory-action' ? service.directoryAction(body, owner) : service.action(body, owner), runnerFactory: (update: any) => {
    runner = new CodexRunner({ clientFactory: () => client, onUpdate: update, desktopOpener: async () => {} });
    runner.projects = async () => [{ id: 'p', name: 'Repo', cwd: root }]; return runner;
  } });
  await worker.sync();
  assert.equal(service.directoryStatus({ requestId: selection.requestId }, { id: 'requester' }).cwd, root);
  let saved = db.readTaskCenter('default').executions[0]; assert.equal(saved.status, 'running'); assert.ok(saved.threadId);
  await assert.rejects(service.action({ action: 'claim', executionId }, owner), { statusCode: 409 });
  await assert.rejects(service.action({ action: 'report', executionId, report: { status: 'running', threadId: null } }, owner), { statusCode: 409 });
  await worker.sync(); assert.equal(client.calls.filter(c => c.method === 'thread/start').length, 1);
  client.emit('request', { id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: saved.threadId, command: 'npm test' } });
  await worker.sync(); assert.equal(db.readTaskCenter('default').executions[0].status, 'waiting');
  await service.action({ action: 'respond', executionId, decision: 'decline' }, owner);
  await worker.sync(); assert.equal(db.readTaskCenter('default').executions[0].control, null);
  client.emit('notification', { method: 'turn/completed', params: { threadId: saved.threadId, turn: { id: 'turn-1', status: 'completed' } } });
  await worker.sync(); assert.equal((await center.snapshot()).tasks[0].status, 'review'); worker.close();
});

test('resumes the original thread without creating or renaming it, and routes consecutive turns correctly', async () => {
  const client = new FakeClient(), updates: any[] = [], opened: string[] = [];
  const call = client.call.bind(client); let turnNumber = 0;
  client.call = async (method: any, params: any) => {
    if (method === 'thread/resume') { client.calls.push({ method, params }); return { thread: { id: params.threadId } }; }
    if (method === 'turn/start') { client.calls.push({ method, params }); return { turn: { id: `new-${++turnNumber}` } }; }
    return call(method, params);
  };
  const threadId = '12345678-1234-1234-1234-123456789abc';
  const runner = new CodexRunner({ clientFactory: () => client, onUpdate: (j: any) => updates.push(j), desktopOpener: async (id: string) => { opened.push(id); } });
  await runner.start({ ...job(), resumeThreadId: threadId, prompt: '第一轮续聊' });
  assert.deepEqual(client.calls.find(c => c.method === 'thread/resume').params, { threadId });
  assert.ok(!client.calls.some(c => ['thread/start', 'thread/name/set'].includes(c.method)));
  assert.equal(client.calls.find(c => c.method === 'turn/start').params.threadId, threadId);
  await runner.notification({ method: 'turn/completed', params: { threadId, turn: { id: 'new-1', status: 'completed' } } });
  await runner.start({ ...job(), id: 'job-2', resumeThreadId: threadId, prompt: '第二轮续聊' });
  const before = updates.length;
  await runner.notification({ method: 'turn/completed', params: { threadId, turn: { id: 'new-1', status: 'completed' } } });
  assert.equal(updates.length, before, 'late completion from old turn is ignored');
  await runner.notification({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'new-2', delta: '第二轮回复' } });
  assert.equal(updates.at(-1).id, 'job-2'); assert.equal(updates.at(-1).output, '第二轮回复');
  await runner.notification({ method: 'turn/completed', params: { threadId, turn: { id: 'new-2', status: 'completed' } } });
  assert.deepEqual(opened, [threadId, threadId]); runner.close();
});

test('busy or unavailable original threads never fall back to a new thread', async () => {
  for (const busy of [true, false]) {
    const client = new FakeClient(), updates: any[] = [];
    client.call = async (method: any, params: any) => {
      client.calls.push({ method, params });
      if (method === 'thread/read') return { thread: { turns: busy ? [{ status: 'inProgress' }] : [] } };
      throw Object.assign(new Error('resume unavailable'), { code: -32601 });
    };
    const runner = new CodexRunner({ clientFactory: () => client, onUpdate: (j: any) => updates.push(j) });
    await runner.start({ ...job(), resumeThreadId: 'original' });
    assert.equal(updates.at(-1).status, 'failed');
    assert.ok(!client.calls.some(c => ['thread/start', 'turn/start'].includes(c.method))); runner.close();
  }
});

test('history continuation is scoped, idempotent, task-owned and retains a single session', async t => {
  const db = openDatabase(':memory:'); db.createTenant({ id: 'default', token: 'x'.repeat(32) }); t.after(() => db.close());
  const id = 'a'.repeat(64), nativeId = '12345678-1234-1234-1234-123456789abc';
  let agent = 'codex';
  const history: any = { catalog: async () => ({ providers: [{ id: 'codex' }], sessions: [{ id, sessionId: nativeId, agent, title: '历史任务', cwd: '/repo' }] }), resolveSource: async (sid: string) => { if (sid !== id) throw Object.assign(new Error('not found'), { statusCode: 404 }); }, detail: async (sid: string) => { await history.resolveSource(sid); return { session: { id, sessionId: nativeId, agent, title: '历史任务', cwd: '/repo' } }; } };
  let started = 0, update: any;
  const service = createCodexExecution({ database: db, tenantId: 'default', workspace: () => '/repo', history, runnerFactory: (notify: any) => { update = notify; return { start(j: any) { started++; notify({ ...j, threadId: nativeId, status: 'running' }); }, close() {} }; } });
  const requestId = '11111111-1111-1111-1111-111111111111';
  const input = { requestId, message: '继续原会话' };
  await assert.rejects(service.continueHistory('b'.repeat(64), input), { statusCode: 404 });
  agent = 'claude'; await assert.rejects(service.continueHistory(id, input), { statusCode: 422 }); agent = 'codex';
  const first = await service.continueHistory(id, input);
  assert.deepEqual(await service.continueHistory(id, input), first); assert.equal(started, 1);
  await assert.rejects(service.continueHistory(id, { ...input, message: 'changed' }), { statusCode: 409 });
  await assert.rejects(service.continueHistory(id, { ...input, requestId: '22222222-2222-2222-2222-222222222222' }), { statusCode: 409 });
  const center = createTaskCenter({ database: db, tenantId: 'default', history });
  assert.equal((await center.snapshot()).sessions.length, 1);
  assert.deepEqual((await center.snapshot()).tasks[0].sessionIds, [id]);
  const saved = db.readTaskCenter('default').executions[0];
  update({ ...saved, status: 'completed', output: '回复' });
  assert.equal((await service.historyExecution(id)).execution.output, '回复');
  assert.equal((await center.snapshot()).tasks[0].status, 'review');
  await service.continueHistory(id, { ...input, requestId: '33333333-3333-3333-3333-333333333333' });
  assert.equal(started, 2); assert.equal(db.readTaskCenter('default').tasks.length, 1);
  service.close();
});
