import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { CodexRunner, createCodexExecution, executionPrompt } from '../src/codexExecution.js';
import { createTaskCenter } from '../src/taskCenter.js';
import { openDatabase } from '../src/database.js';
import type { Actor, Session } from '../public/taskTypes.js';

interface CallParams {
  threadId?: string; ephemeral?: boolean; projectId?: string; approvalPolicy?: unknown; model?: string;
  config?: { model_reasoning_effort?: string }; cwd?: string; [key: string]: unknown;
}
interface ClientCall {
  method: string; params?: CallParams; id?: string | number;
  result?: { decision?: string; answers?: Record<string, { answers: string[] }> };
  [key: string]: unknown;
}
type RunnerOptions = NonNullable<ConstructorParameters<typeof CodexRunner>[0]>;
type RunnerUpdate = Parameters<NonNullable<RunnerOptions['onUpdate']>>[0];
type ExecutionOptions = Parameters<typeof createCodexExecution>[0];
type ExecutionFactory = NonNullable<ExecutionOptions['runnerFactory']>;
type ExecutionUpdate = Parameters<ExecutionFactory>[0];
type ExecutionJob = Parameters<ExecutionUpdate>[0];

class FakeClient extends EventEmitter {
  calls: ClientCall[] = []; closed = false;
  async initialize() { return this; }
  async call(method: string, params: CallParams = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: '12345678-1234-1234-1234-123456789abc' } };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    if (method === 'thread/read') return { thread: { turns: [{ id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text: 'done' }] }] } };
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
    return {};
  }
  send(message: unknown) { this.calls.push(message as ClientCall); }
  close(): void | Promise<void> { this.closed = true; this.emit('disconnected', new Error('closed')); }
}
const job = () => ({ id: 'job-1', taskId: 'task-1', title: '任务', prompt: '实现功能', cwd: '/repo', projectId: 'project-1', status: 'queued' });
const last = <T>(values: T[]): T => { const value = values.at(-1); assert.ok(value); return value; };

test('git operations reuse the recently discovered local target', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-git-target-')); t.after(() => rm(root, { recursive: true, force: true }));
  await promisify(execFile)('git', ['-C', root, 'init', '-b', 'main']);
  const db = openDatabase(':memory:'); t.after(() => db.close()); db.createTenant({ id: 'default', token: 'x'.repeat(32) });
  let discoveries = 0;
  const service = createCodexExecution({ database: db, tenantId: 'default', workspace: () => root, runnerFactory: () => ({
    projects: async () => { discoveries++; return [{ id: 'project', name: 'Repo', cwd: root }]; }, close() {}
  }) });
  t.after(() => service.close());

  await service.targets();
  assert.equal((await service.git({ action: 'list', deviceId: 'local', projectId: 'project' })).repository, true);
  assert.equal(discoveries, 1, 'branch reads should not restart Agent project discovery');
  await assert.rejects(service.git({ action: 'list', deviceId: 'local', projectId: 'unknown' }), /请选择本地执行目标/);
});

test('creates durable project thread, starts a real turn and opens desktop without overriding permissions/model', async () => {
  const client = new FakeClient(), updates: RunnerUpdate[] = [], opened: string[] = [];
  const originalCall = client.call.bind(client);
  client.call = async (method, params) => {
    if (method === 'thread/name/set') throw Object.assign(new Error('thread metadata update is not supported'), { code: -32601 });
    return originalCall(method, params);
  };
  const runner = new CodexRunner({ clientFactory: () => client, onUpdate: j => updates.push(j), desktopOpener: async id => { opened.push(id); } });
  await runner.start(job()); await runner.start(job());
  const starts = client.calls.filter(c => c.method === 'thread/start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.params?.ephemeral, false);
  assert.equal(starts[0]?.params?.projectId, 'project-1');
  assert.equal(starts[0]?.params?.approvalPolicy, undefined);
  assert.equal(starts[0]?.params?.model, undefined);
  assert.deepEqual(opened, ['12345678-1234-1234-1234-123456789abc']);
  assert.equal(last(updates).status, 'running');
  await runner.notification({ method: 'item/completed', params: { threadId: opened[0], item: { type: 'agentMessage', text: '验证通过' } } });
  await runner.notification({ method: 'turn/completed', params: { threadId: opened[0], turn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(last(updates).status, 'completed'); assert.equal(last(updates).output, '验证通过');
  assert.deepEqual(client.calls.at(-1), { method: 'thread/unsubscribe', params: { threadId: opened[0] } });
  assert.equal(last(updates).subscriptionStatus, 'unsubscribed');
  runner.close(); assert.equal(last(updates).status, 'completed');
});

test('passes an explicitly selected model and reasoning effort to Codex', async () => {
  const client = new FakeClient();
  const runner = new CodexRunner({ clientFactory: () => client, desktopOpener: async () => {} });
  await runner.start({ ...job(), model: 'gpt-test', reasoningEffort: 'high' });
  const start = client.calls.find(call => call.method === 'thread/start');
  assert.equal(start?.params?.model, 'gpt-test');
  assert.deepEqual(start?.params?.config, { model_reasoning_effort: 'high' });
  runner.close();
})
test('terminal failures keep their execution result when releasing the desktop subscription fails', async () => {
  const client = new FakeClient(), updates: RunnerUpdate[] = [];
  const originalCall = client.call.bind(client);
  client.call = async (method, params) => {
    if (method === 'thread/unsubscribe') { client.calls.push({ method, params }); throw new Error('connection lost'); }
    return originalCall(method, params);
  };
  const runner = new CodexRunner({ clientFactory: () => client, onUpdate: j => updates.push(j), desktopOpener: async () => {} });
  await runner.start(job());
  await runner.notification({ method: 'turn/completed', params: { threadId: last(updates).threadId, turn: { id: 'turn-1', status: 'failed', error: { message: 'tests failed' } } } });
  assert.equal(last(updates).status, 'failed');
  assert.equal(last(updates).message, 'tests failed');
  assert.equal(last(updates).releaseError, 'connection lost');
});

test('reconciliation releases a completed thread subscription', async () => {
  const client = new FakeClient(), updates: RunnerUpdate[] = [];
  const runner = new CodexRunner({ clientFactory: () => client, onUpdate: j => updates.push(j), desktopOpener: async () => {} });
  const saved = { ...job(), threadId: '12345678-1234-1234-1234-123456789abc', turnId: 'turn-1', status: 'unknown' };
  await runner.reconcile(saved);
  assert.equal(last(updates).status, 'completed');
  assert.equal(last(updates).subscriptionStatus, 'unsubscribed');
  assert.deepEqual(client.calls.slice(-2).map(call => call.method), ['thread/read', 'thread/unsubscribe']);
});

test('approval and input require an explicit answer; stop uses native turn interrupt', async () => {
  const client = new FakeClient(), updates: RunnerUpdate[] = [];
  const runner = new CodexRunner({ clientFactory: () => client, onUpdate: j => updates.push(j), desktopOpener: async () => {} });
  await runner.start(job()); const threadId = updates.at(-1)?.threadId;
  client.emit('request', { id: 42, method: 'item/commandExecution/requestApproval', params: { threadId, command: 'npm test' } });
  assert.equal(last(updates).status, 'waiting'); assert.ok(!client.calls.some(c => c.id === 42));
  await assert.rejects(runner.respond('job-1', { decision: 'acceptForSession' }), { statusCode: 400 });
  await runner.respond('job-1', { decision: 'decline' });
  assert.deepEqual(client.calls.at(-1), { id: 42, result: { decision: 'decline' } });
  client.emit('request', { id: 43, method: 'item/tool/requestUserInput', params: { threadId, questions: [{ id: 'q', question: '怎么处理？' }] } });
  await assert.rejects(runner.respond('job-1', { answers: {} }), { statusCode: 400 });
  await runner.respond('job-1', { answers: { q: '继续测试' } });
  assert.deepEqual(last(client.calls).result, { answers: { q: { answers: ['继续测试'] } } });
  await runner.stop('job-1'); assert.equal(last(client.calls).method, 'turn/interrupt'); runner.close();
});

test('uncertain create and disconnected runs never automatically rerun', async () => {
  const client = new FakeClient(), updates: RunnerUpdate[] = [];
  client.call = async method => { if (method === 'thread/start') throw new Error('timeout'); return {}; };
  const runner = new CodexRunner({ clientFactory: () => client, onUpdate: j => updates.push(j), desktopOpener: async () => {} });
  await runner.start(job()); assert.equal(last(updates).status, 'unknown');
  assert.equal(last(updates).threadId, undefined); runner.close();
});

test('uses the configured workspace when newer Codex removes project/list', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-workspace-target-')); t.after(() => rm(root, { recursive: true, force: true }));
  const client = new FakeClient();
  const originalCall = client.call.bind(client);
  client.call = async (method, params) => {
    if (method === 'project/list') throw Object.assign(new Error('Method not found: project/list. Supported methods: thread/start'), { code: -32601 });
    return originalCall(method, params);
  };
  const runner = new CodexRunner({ clientFactory: () => client, desktopOpener: async () => {} });
  const targets = await runner.projects(root);
  assert.equal(targets.length, 1); assert.equal(targets[0].cwd, await realpath(root)); assert.equal(targets[0].appServerProjectId, null);
  await runner.start({ ...job(), id: 'workspace-job', cwd: targets[0].cwd, projectId: targets[0].id, appServerProjectId: null });
  const start = client.calls.find(call => call.method === 'thread/start');
  assert.equal(start?.params?.cwd, targets[0].cwd); assert.equal(start?.params?.projectId, undefined);
  runner.close();
});

test('mirrors the complete Codex model catalog and its default model', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-model-catalog-')); t.after(() => rm(root, { recursive: true, force: true }));
  const client = new FakeClient();
  const originalCall = client.call.bind(client);
  client.call = async (method, params) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'model/list') {
      client.calls.push({ method, params });
      if (!params?.cursor) return {
        data: [
          { id: 'gpt-6-astra', displayName: '6 Astra', description: 'Frontier model', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Deep reasoning' }] },
          { id: 'hidden-model', displayName: 'Hidden', hidden: true }
        ],
        nextCursor: 'page-2'
      };
      return { data: [{ id: 'gpt-5.6-sol', displayName: '5.6 Sol', hidden: false, isDefault: true, defaultReasoningEffort: 'low' }], nextCursor: null };
    }
    if (method === 'project/list') return { data: [{ id: 'project', name: 'Repo', roots: [{ path: root }] }], nextCursor: null };
    return originalCall(method, params);
  };
  const runner = new CodexRunner({ clientFactory: () => client, desktopOpener: async () => {} });
  const [target] = await runner.projects(root);
  assert.equal(target.defaultModel, 'gpt-5.6-sol');
  assert.deepEqual(target.models?.map(model => model.id), ['gpt-6-astra', 'gpt-5.6-sol']);
  assert.equal(target.models?.[0]?.reasoningEfforts?.[0]?.id, 'high');
  assert.deepEqual(client.calls.filter(call => call.method === 'model/list').map(call => call.params?.cursor), [undefined, 'page-2']);
  runner.close();
});

test('durable execution reservations isolate tenants, reject duplicates, and recover restart as unknown', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-execution-')); t.after(() => rm(root, { recursive: true, force: true }));
  const alternative = path.join(root, 'another-project'); await mkdir(alternative);
  const db = openDatabase(':memory:'); t.after(() => db.close());
  db.createTenant({ id: 'default', token: 'x'.repeat(32) }); db.createTenant({ id: 'other', token: 'y'.repeat(32) });
  const history = { catalog: async () => ({ sessions: [], providers: [] }) };
  const center = createTaskCenter({ database: db, tenantId: 'default', history });
  await center.command({ action: 'create', title: '测试执行' }, { id: 'owner' });
  const task = (await center.snapshot()).tasks[0];
  let update: ExecutionUpdate = () => {}, started = 0;
  const factory: ExecutionFactory = fn => { update = fn; return { projects: async () => [{ id: 'project-1', name: 'Repo', cwd: root, models: [{ id: 'model-1', name: 'Model 1', reasoningEfforts: [{ id: 'high', name: 'High' }] }] }], start: async j => { started++; fn({ ...j, threadId: '12345678-1234-1234-1234-123456789abc', status: 'running', message: 'running' }); }, close() {} }; };
  const service = createCodexExecution({ database: db, tenantId: 'default', workspace: () => root, runnerFactory: factory, directoryPicker: async () => alternative });
  const input = { taskId: task.id, revision: task.revision, projectId: 'project-1', cwd: root };
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
  assert.equal(db.readTaskCenter('default').executions.at(-1)!.cwd, await realpath(alternative), 'an arbitrary accessible cwd is accepted');
  assert.match(db.readTaskCenter('default').executions.at(-1)!.prompt, /补充回归验证/);
  assert.match(db.readTaskCenter('default').executions.at(-1)!.prompt, /历史参考材料/);
  assert.equal(db.readTaskCenter('default').executions.at(-1)!.sourceSessionId, latest.sessionIds[0]);
  assert.equal(db.readTaskCenter('default').executions.at(-1)!.model, 'model-1');
  assert.equal(db.readTaskCenter('default').executions.at(-1)!.reasoningEffort, 'high');
  assert.ok((await service.targets()).projects[0].commonDirectories.includes(await realpath(alternative)));
  update({ ...db.readTaskCenter('default').executions[0], status: 'completed', desktopOpened: true });
  assert.equal((await center.snapshot()).tasks[0].status, 'running', 'late updates from an old run must not overwrite the newer run');
  service.close();
  const restarted = createCodexExecution({ database: db, tenantId: 'default', workspace: () => root, runnerFactory: factory });
  assert.equal(db.readTaskCenter('default').executions.at(-1)!.status, 'unknown');
  await assert.rejects(restarted.execute({ ...input, revision: (await center.snapshot()).tasks[0].revision }), { statusCode: 409 });
  assert.equal(started, 2); assert.ok(result.executionId); restarted.close();
});

test('remote device claims once, reports real thread state, and rejects other device accounts', async t => {
  const { RemoteCodexWorker } = await import('../src/remoteCodexWorker.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-codex-')); t.after(() => rm(root, { recursive: true, force: true }));
  const db = openDatabase(':memory:'); t.after(() => db.close()); db.createTenant({ id: 'default', token: 'x'.repeat(32) });
  const center = createTaskCenter({ database: db, tenantId: 'default', history: { catalog: async () => ({ sessions: [], providers: [] }) } });
  const owner: Actor = { id: 'device-owner' };
  await center.command({ action: 'heartbeat', deviceId: 'remote', name: 'Remote Mac', agents: ['codex'], sessions: [], codexProjects: [{ id: 'p', name: 'Repo', cwd: root }] }, owner);
  await center.command({ action: 'create', title: '远端执行' }, owner);
  const service = createCodexExecution({ database: db, tenantId: 'default', workspace: () => root, runnerFactory: () => ({ projects: async () => [], close() {} }) });
  t.after(() => service.close());
  const task = (await center.snapshot()).tasks[0];
  const { executionId } = await service.execute({ taskId: task.id, revision: task.revision, deviceId: 'remote', projectId: 'p', cwd: root });
  const selection = await service.pickDirectory({ deviceId: 'remote', projectId: 'p' }, { id: 'requester' });
  assert.ok('requestId' in selection);
  assert.equal(db.readTaskCenter('default').executions[0].status, 'queued');
  await assert.rejects(service.action({ action: 'claim', executionId }, { id: 'other' }), { statusCode: 403 });
  const client = new FakeClient();
  type Service = ReturnType<typeof createCodexExecution>;
  const worker = new RemoteCodexWorker({ deviceId: 'remote', workspace: root, directory: path.join(root, 'journal'), directoryPicker: async () => root, request: (method, body, endpoint) => method === 'GET' ? center.snapshot() : endpoint === '/api/task-center/directory-action' ? service.directoryAction(body as Parameters<Service['directoryAction']>[0], owner) : service.action(body as Parameters<Service['action']>[0], owner), runnerFactory: update => {
    const runner = new CodexRunner({ clientFactory: () => client, onUpdate: value => update(value), desktopOpener: async () => {} });
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
  const client = new FakeClient(), updates: RunnerUpdate[] = [], opened: string[] = [];
  const call = client.call.bind(client); let turnNumber = 0;
  client.call = async (method, params) => {
    if (method === 'thread/resume') { client.calls.push({ method, params }); return { thread: { id: params?.threadId } }; }
    if (method === 'turn/start') { client.calls.push({ method, params }); return { turn: { id: `new-${++turnNumber}` } }; }
    return call(method, params);
  };
  const threadId = '12345678-1234-1234-1234-123456789abc';
  const runner = new CodexRunner({ clientFactory: () => client, onUpdate: j => updates.push(j), desktopOpener: async id => { opened.push(id); } });
  await runner.start({ ...job(), resumeThreadId: threadId, prompt: '第一轮续聊' });
  assert.deepEqual(client.calls.find(c => c.method === 'thread/resume')?.params, { threadId });
  assert.ok(!client.calls.some(c => ['thread/start', 'thread/name/set'].includes(c.method)));
  assert.equal(client.calls.find(c => c.method === 'turn/start')?.params?.threadId, threadId);
  await runner.notification({ method: 'turn/completed', params: { threadId, turn: { id: 'new-1', status: 'completed' } } });
  await runner.start({ ...job(), id: 'job-2', resumeThreadId: threadId, prompt: '第二轮续聊' });
  const before = updates.length;
  await runner.notification({ method: 'turn/completed', params: { threadId, turn: { id: 'new-1', status: 'completed' } } });
  assert.equal(updates.length, before, 'late completion from old turn is ignored');
  await runner.notification({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'new-2', delta: '第二轮回复' } });
  assert.equal(last(updates).id, 'job-2'); assert.equal(last(updates).output, '第二轮回复');
  await runner.notification({ method: 'turn/completed', params: { threadId, turn: { id: 'new-2', status: 'completed' } } });
  assert.deepEqual(opened, [threadId, threadId]); runner.close();
});

test('native Codex turn receives the Markdown file reference and unchanged original image bytes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const markdown = path.join(root, 'handoff.md'), image = path.join(root, 'original.png');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await writeFile(markdown, '# 交接'); await writeFile(image, bytes);
  const ref = { id: 'image-1', path: image, mimeType: 'image/png' as const, size: bytes.length, sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex') };
  const client = new FakeClient(), runner = new CodexRunner({ clientFactory: () => client });
  await runner.start({ ...job(), cwd: root, prompt: `读取 ${markdown} 后继续`, contextMarkdownPath: markdown, promptImages: [ref] });
  assert.deepEqual(client.calls.find(call => call.method === 'turn/start')?.params?.input, [
    { type: 'text', text: `读取 ${markdown} 后继续` }, { type: 'localImage', path: image }
  ]);
  runner.close();
  await writeFile(image, 'tampered');
  const rejected = new FakeClient(), rejectedRunner = new CodexRunner({ clientFactory: () => rejected });
  await rejectedRunner.start({ ...job(), id: 'bad-image', cwd: root, contextMarkdownPath: markdown, promptImages: [ref] });
  assert.equal(rejected.calls.some(call => call.method === 'thread/start' || call.method === 'turn/start'), false);
  rejectedRunner.close();
});

test('busy or unavailable original threads never fall back to a new thread', async () => {
  for (const busy of [true, false]) {
    const client = new FakeClient(), updates: RunnerUpdate[] = [];
    client.call = async (method, params) => {
      client.calls.push({ method, params });
      if (method === 'thread/read') return { thread: { turns: busy ? [{ status: 'inProgress' }] : [] } };
      throw Object.assign(new Error('resume unavailable'), { code: -32601 });
    };
    const runner = new CodexRunner({ clientFactory: () => client, onUpdate: j => updates.push(j) });
    await runner.start({ ...job(), resumeThreadId: 'original' });
    assert.equal(last(updates).status, 'failed');
    assert.ok(!client.calls.some(c => ['thread/start', 'turn/start'].includes(c.method))); runner.close();
  }
});

test('history continuation is scoped, idempotent, task-owned and retains a single session', async t => {
  const db = openDatabase(':memory:'); db.createTenant({ id: 'default', token: 'x'.repeat(32) }); t.after(() => db.close());
  const id = 'a'.repeat(64), nativeId = '12345678-1234-1234-1234-123456789abc';
  let agent = 'codex';
  const historySession = (): Session => ({ id, sessionId: nativeId, agent, deviceId: 'local', title: '历史任务', cwd: '/repo', updatedAt: new Date().toISOString() });
  const history = { catalog: async () => ({ providers: [{ id: 'codex' }], sessions: [historySession()] }), resolveSource: async (sid: string) => { if (sid !== id) throw Object.assign(new Error('not found'), { statusCode: 404 }); }, detail: async (sid: string) => { await history.resolveSource(sid); return { session: historySession() }; } };
  let started = 0, update: ExecutionUpdate = () => {};
  const service = createCodexExecution({ database: db, tenantId: 'default', workspace: () => '/repo', history, runnerFactory: notify => { update = notify; return { start(j) { started++; notify({ ...j, threadId: nativeId, status: 'running' }); }, close() {} }; } });
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
  assert.equal((await service.historyExecution(id)).execution!.output, '回复');
  assert.equal((await center.snapshot()).tasks[0].status, 'review');
  await service.continueHistory(id, { ...input, requestId: '33333333-3333-3333-3333-333333333333' });
  assert.equal(started, 2); assert.equal(db.readTaskCenter('default').tasks.length, 1);
  service.close();
});

test('active writer conflicts preserve the unsent prompt and do not start, fork or interrupt a turn', async () => {
  const client = new FakeClient(), updates: RunnerUpdate[] = [];
  client.call = async (method, params) => {
    client.calls.push({ method, params });
    if (method === 'thread/read') return { thread: { turns: [] } };
    throw Object.assign(new Error('thread original already has an active writer'), { code: -32600 });
  };
  const runner = new CodexRunner({ clientFactory: () => client, onUpdate: j => updates.push(j) });
  await runner.start({ ...job(), resumeThreadId: 'original', prompt: '保留这条消息' });
  assert.equal(last(updates).status, 'blocked');
  assert.equal(last(updates).errorCode, 'CODEX_THREAD_BUSY');
  assert.equal(last(updates).prompt, '保留这条消息');
  assert.deepEqual(client.calls.map(c => c.method), ['thread/read', 'thread/resume']);
  runner.close();
});

test('terminal runs close their own process even if unsubscribe fails, without interrupting another run', async () => {
  const clients: FakeClient[] = [], updates: RunnerUpdate[] = [];
  const runner = new CodexRunner({ clientFactory: () => {
    const client = new FakeClient(), id = `thread-${clients.length}`;
    const call = client.call.bind(client);
    client.call = async (method, params) => {
      if (method === 'thread/start') return { thread: { id } };
      if (method === 'thread/unsubscribe') throw new Error('unsubscribe unsupported');
      return call(method, params);
    };
    clients.push(client); return client;
  }, onUpdate: j => updates.push(j), desktopOpener: async () => {} });
  await runner.start({ ...job(), id: 'first' });
  await runner.start({ ...job(), id: 'second' });
  await runner.notification({ method: 'turn/completed', params: { threadId: 'thread-0', turn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(clients[0].closed, true);
  assert.equal(clients[1].closed, false);
  assert.equal(runner.jobs.get('second').status, 'running');
  assert.equal(runner.jobs.get('first').releaseStatus, 'released');
  assert.equal(runner.jobs.get('first').status, 'completed');
  assert.equal(runner.jobClients.has('first'), false);
  await runner.notification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
  assert.equal(clients[1].closed, true);
  assert.equal(runner.jobs.get('second').releaseStatus, 'released'); runner.close();
});

test('release is not reported complete before the owned process actually exits', async () => {
  const client = new FakeClient(); let exit: () => void = () => {};
  const closing = new Promise<void>(resolve => { exit = resolve; });
  client.close = () => closing.then(() => { client.closed = true; });
  const runner = new CodexRunner({ clientFactory: () => client, desktopOpener: async () => {} });
  await runner.start(job());
  const finished = runner.notification({ method: 'turn/completed', params: { threadId: runner.jobs.get('job-1').threadId, turn: { id: 'turn-1', status: 'completed' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runner.jobs.get('job-1').releaseStatus, 'releasing');
  exit(); await finished;
  assert.equal(runner.jobs.get('job-1').releaseStatus, 'released');
});

test('busy original thread is submitted through its desktop owner without a second resume or direct turn', async () => {
  const reader = new FakeClient(), bridge = new FakeClient(), updates: RunnerUpdate[] = [];
  const readCall = reader.call.bind(reader);
  reader.call = async (method, params) => {
    if (method === 'thread/resume') { reader.calls.push({ method, params }); throw new Error('already has an active writer'); }
    return readCall(method, params);
  };
  const runner = new CodexRunner({ clientFactory: () => reader, desktopBridgeFactory: async () => bridge, onUpdate: value => updates.push(value), desktopOpener: async () => assert.fail('must not reopen desktop') });
  await runner.start({ ...job(), resumeThreadId: 'original' });
  assert.equal(last(updates).executionTransport, 'desktop-ipc');
  assert.equal(last(updates).status, 'running');
  assert.equal(reader.calls.some(c => c.method === 'turn/start'), false);
  assert.equal(bridge.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal(bridge.calls.find(c => c.method === 'turn/start')?.params?.threadId, 'original');
  await runner.notification({ method: 'turn/completed', params: { threadId: 'original', turn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(bridge.closed, true);
  assert.equal(last(updates).releaseStatus, 'released');
});

test('desktop submission timeout stays unknown and never falls back to a direct writer', async () => {
  const reader = new FakeClient(), bridge = new FakeClient(), updates: RunnerUpdate[] = [];
  const readCall = reader.call.bind(reader);
  reader.call = async (method, params) => { if (method === 'thread/resume') throw new Error('already has an active writer'); return readCall(method, params); };
  bridge.call = async () => { throw new Error('timeout'); };
  const runner = new CodexRunner({ clientFactory: () => reader, desktopBridgeFactory: async () => bridge, onUpdate: value => updates.push(value) });
  await runner.start({ ...job(), resumeThreadId: 'original' });
  assert.equal(last(updates).status, 'unknown');
  assert.equal(reader.calls.some(c => c.method === 'turn/start' || c.method === 'thread/start'), false);
  runner.close();
});


test('uploaded attachments reach the local runner as durable file references and reject remote execution', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'execution-files-')); t.after(() => rm(root, { recursive: true, force: true }));
  const db = openDatabase(':memory:'); t.after(() => db.close()); db.createTenant({ id: 'default', token: 'x'.repeat(32) });
  const center = createTaskCenter({ database: db, tenantId: 'default', history: { catalog: async () => ({ sessions: [], providers: [] }) } });
  await center.command({ action: 'create', title: 'Read attachment' }, { id: 'owner' });
  const task = (await center.snapshot()).tasks[0]; let started: ExecutionJob | undefined;
  const service = createCodexExecution({ database: db, tenantId: 'default', workspace: () => root, attachmentRoot: path.join(root, 'uploads'), runnerFactory: () => ({ projects: async () => [{ id: 'p', cwd: root }], start: async job => { started = job; }, close() {} }) });
  const input = { taskId: task.id, revision: task.revision, projectId: 'p', attachments: [{ name: 'notes.txt', data: Buffer.from('attachment content').toString('base64') }] };
  await assert.rejects(service.execute({ ...input, deviceId: 'remote' }), /附件暂仅/);
  await service.execute(input);
  assert.ok(started);
  assert.ok(started.attachments?.[0]);
  assert.equal(await readFile(started.attachments[0].path, 'utf8'), 'attachment content');
  assert.ok(started.prompt.includes(started.attachments[0].path));
  assert.match(started.prompt, /仅作为参考材料/);
  assert.equal(db.readTaskCenter('default').executions[0]!.attachments?.[0]?.name, 'notes.txt');
});

test('execution prompt uses the Markdown body without empty structured fields', () => { const body = '# Goal\n\n- Constraint\n\n**Result**'; const prompt = executionPrompt({ title: 'Goal', content: body }); assert.equal(prompt, body); assert.doesNotMatch(prompt, /未填写|已确认结论/); });
