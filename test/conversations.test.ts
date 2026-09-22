import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import { createAgentHistory } from '../src/agentHistory/index.js';
import { createSessionDelivery } from '../src/sessionDelivery/index.js';
import { createConversations } from '../src/conversations.js';
import { createCodexExecution } from '../src/codexExecution.js';
import { contextPrompt, freezeContext, readContext } from '../src/contextCompiler.js';
import { permissionForRoute } from '../src/rbac.js';
type ExecutionOptions = Parameters<typeof createCodexExecution>[0];
type Update = Parameters<NonNullable<ExecutionOptions['runnerFactory']>>[0];
type RunnerJob = Parameters<Update>[0];
const line = (row: unknown) => JSON.stringify(row) + '\n';
const message = (text: string, role = 'user') => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } });
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'conversation-'));
  const records = path.join(root, 'records'); await mkdir(records);
  const file = path.join(records, 'session.jsonl');
  await writeFile(file, line({ type: 'session_meta', payload: { id: 'source-native', cwd: root } }) + line(message('保持原接口兼容')) + line(message('先定位问题，再补充测试', 'assistant')));
  const environment = { IDE_HISTORY_CODEX_DIR: records, IDE_HISTORY_CLAUDE_DIR: path.join(root, 'absent'), SECRET: 'secret-for-context-test' };
  const database = openDatabase(path.join(root, 'data.sqlite')); database.createTenant({ id: 'default', token: 'x'.repeat(32) }); database.createTenant({ id: 'other', token: 'y'.repeat(32) });
  const history = createAgentHistory({ environment, workspace: () => root });
  const delivery = createSessionDelivery({ history, environment });
  const source = (await history.catalog()).sessions[0]!.id;
  let update: Update = () => {}; const launched: RunnerJob[] = [];
  const execution = createCodexExecution({ database, tenantId: 'default', workspace: () => root, history, runnerFactory: notify => {
    update = notify;
    return { projects: async () => ['codex', 'claude'].map(agent => ({ id: agent, agent, protocol: 'acp' as const, cwd: root })), start: async job => { launched.push(job); update({ ...job, status: 'running', sessionId: job.resumeSessionId || randomUUID() }); }, close() {} };
  } });
  const options = { database, tenantId: 'default', history, delivery, execution, environment, contextRoot: path.join(root, 'context') };
  const service = createConversations(options);
  t.after(async () => { execution.close(); database.close(); await rm(root, { recursive: true, force: true }); });
  const finish = (output = '已补充测试，全部通过') => { const job = database.readTaskCenter('default').executions.at(-1); assert.ok(job); update({ ...job, status: 'completed', output }); };
  return { root, file, database, history, delivery, source, execution, options, service, launched, finish };
}

test('new conversation is ready without executing historical requests; first message inherits full evidence', async t => {
  const f = await fixture(t), long = 'TOOL_RESULT_'.repeat(4000);
  await appendFile(f.file, line({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'test', output: long } }) + line(message('secret-for-context-test')) + line(message('hidden-system', 'system')));
  const created = await f.service.create(f.source, { requestId: randomUUID(), targetAgent: 'claude' });
  assert.equal(f.launched.length, 0);
  const detail = f.service.detail(created.sessionId);
  assert.equal(detail.session.agent, 'claude'); assert.equal(detail.session.cwd, await import('node:fs/promises').then(fs => fs.realpath(f.root)));
  assert.equal(detail.total, 0); assert.ok(detail.inherited.count >= 3);
  await f.service.send(created.sessionId, { requestId: randomUUID(), message: '按刚才的方案继续' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.length, 1);
  assert.match(f.launched[0].prompt, /保持原接口兼容/); assert.ok(f.launched[0].prompt.includes(long));
  assert.doesNotMatch(f.launched[0].prompt, /hidden-system|secret-for-context-test/);
  assert.equal(f.service.detail(created.sessionId).messages[0].text, '按刚才的方案继续');
});

test('create and send are idempotent, reject reused keys, and reuse the native session on subsequent turns', async t => {
  const f = await fixture(t), input = { requestId: randomUUID(), targetAgent: 'claude', message: '继续实现' };
  const created = await f.service.create(f.source, input);
  assert.deepEqual(await f.service.create(f.source, input), created);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.launched.length, 1);
  await assert.rejects(f.service.create(f.source, { ...input, targetAgent: 'codex' }), { statusCode: 409 });
  await assert.rejects(f.service.send(created.sessionId, { requestId: input.requestId, message: '修改消息' }), { statusCode: 409 });
  const nativeId = f.service.detail(created.sessionId).session.nativeId;
  f.finish();
  await f.service.send(created.sessionId, { requestId: randomUUID(), message: '再检查边界条件' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched[1].resumeSessionId, nativeId);
  assert.equal(f.launched[1].prompt, '再检查边界条件');
});

test('switching back carries original context and new turns without nesting injected prompts', async t => {
  const f = await fixture(t);
  const a = await f.service.create(f.source, { requestId: randomUUID(), targetAgent: 'claude', message: '继续补测试' });
  await new Promise(resolve => setImmediate(resolve)); f.finish();
  const b = await f.service.create(a.sessionId, { requestId: randomUUID(), targetAgent: 'codex', message: '检查上面的结果' });
  await new Promise(resolve => setImmediate(resolve));
  const prompt = f.launched[1].prompt;
  for (const text of ['保持原接口兼容', '继续补测试', '已补充测试，全部通过', '检查上面的结果']) assert.ok(prompt.includes(text));
  assert.equal(prompt.split('<inherited_context>').length, 2);
  assert.equal(a.taskId, b.taskId); assert.equal(f.database.readTaskCenter('default').tasks.length, 1);
});

test('busy source queues preparation and captures the final reply automatically', async t => {
  const f = await fixture(t);
  const a = await f.service.create(f.source, { requestId: randomUUID(), targetAgent: 'claude', message: '修复' });
  await new Promise(resolve => setImmediate(resolve));
  const b = await f.service.create(a.sessionId, { requestId: randomUUID(), targetAgent: 'codex', message: '检查修复' });
  assert.equal(f.service.detail(b.sessionId).session.status, 'preparing');
  await f.service.preparePending(); assert.equal(f.launched.length, 1);
  f.finish('最后完成修复'); await f.service.preparePending(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.length, 2); assert.match(f.launched[1].prompt, /最后完成修复/);
});

test('frozen context survives new service instances and source edits; tenant cannot read another context', async t => {
  const f = await fixture(t);
  const created = await f.service.create(f.source, { requestId: randomUUID(), targetAgent: 'claude' });
  await appendFile(f.file, line(message('交接后新增的消息')));
  const restarted = createConversations(f.options);
  await restarted.send(created.sessionId, { requestId: randomUUID(), message: '继续' });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(f.launched[0].prompt, /交接后新增的消息/);
  const foreign = createConversations({ ...f.options, tenantId: 'other', history: { catalog: async () => ({ sessions: [] }) } });
  assert.throws(() => foreign.detail(created.sessionId), { statusCode: 404 });
  await assert.rejects(foreign.create(created.sessionId, { requestId: randomUUID(), targetAgent: 'codex' }), { statusCode: 404 });
  assert.equal(f.database.readSessionContext('other', f.service.detail(created.sessionId).session.contextId), null);
});

test('compaction leaves all source evidence readable and marks omissions', async t => {
  const f = await fixture(t);
  const entries = Array.from({ length: 30 }, (_, i) => ({ role: 'assistant', text: `record-${i} ` + 'x'.repeat(500), source: f.source }));
  const snapshot = freezeContext(entries, [f.source]);
  const result = await contextPrompt(snapshot, '继续', path.join(f.root, 'context'), 3000);
  assert.equal(result.compacted, true); assert.match(result.prompt, /完整历史已保存在/); assert.match(result.prompt, /record-29/);
  const saved = JSON.parse(await readFile(path.join(f.root, 'context', `${snapshot.id}.json`), 'utf8'));
  assert.deepEqual(saved.entries, entries); assert.equal(saved.digest, snapshot.digest);
});

test('delivery reads all pages and avoids duplicate Codex event messages', async t => {
  const f = await fixture(t);
  await appendFile(f.file, Array.from({ length: 220 }, (_, i) => line(message(`turn-${i}`))).join('') + line({ type: 'event_msg', payload: { type: 'user_message', message: 'turn-219' } }));
  const result = await readContext(f.delivery, f.source);
  assert.equal(result.entries.length, 222); assert.equal(result.entries.filter(e => e.text.includes('turn-219')).length, 1);
});

test('new routes explicitly separate execution and read permissions', () => {
  const id = 'a'.repeat(64);
  assert.equal(permissionForRoute('POST', `/api/sessions/${id}/continue-as-new`), 'work.execute');
  assert.equal(permissionForRoute('GET', `/api/conversations/${id}/inherited`), 'read');
  assert.equal(permissionForRoute('GET', '/api/conversations'), 'read');
});

test('a persisted initial message is dispatched once after preparation was interrupted', async t => {
  const f = await fixture(t);
  const created = await f.service.create(f.source, { requestId: randomUUID(), targetAgent: 'claude' });
  const requestId = randomUUID();
  f.database.mutateTaskCenter('default', data => {
    const session = data.sessions.find(candidate => candidate.id === created.sessionId);
    assert.ok(session);
    session.pendingMessage = '继续未发送的消息'; session.pendingRequestId = requestId;
  });
  const restarted = createConversations(f.options);
  await restarted.preparePending(); await new Promise(resolve => setImmediate(resolve));
  await restarted.preparePending();
  assert.equal(f.launched.length, 1);
  assert.equal(f.launched[0].requestId, requestId);
  assert.equal(f.service.detail(created.sessionId).session.pendingMessage, '');
});

test('mixed Codex logs retain event-only turns and deduplicate only mirrored occurrences', async t => {
  const f = await fixture(t);
  await appendFile(f.file, line({ type: 'event_msg', payload: { type: 'user_message', message: '保持原接口兼容' } }) +
    line({ type: 'turn_context', payload: { turn_id: 'next-turn', cwd: f.root } }) +
    line({ type: 'event_msg', payload: { type: 'user_message', message: '保持原接口兼容' } }) +
    line({ type: 'event_msg', payload: { type: 'agent_message', message: 'event-only reply' } }));
  const result = await readContext(f.delivery, f.source);
  assert.equal(result.entries.filter(e => e.text.includes('保持原接口兼容')).length, 2);
  assert.ok(result.entries.some(e => e.text === 'event-only reply'));
});

test('history listing merges, filters and paginates managed conversations without duplicate native sessions', async t => {
  const f = await fixture(t);
  const created = await f.service.create(f.source, { requestId: randomUUID(), targetAgent: 'claude' });
  const filtered = await f.service.historyList(new URLSearchParams({ agent: 'claude', limit: '1' }));
  assert.equal(filtered.total, 1); assert.equal(filtered.sessions[0].id, created.sessionId);
  assert.equal((await f.service.historyList(new URLSearchParams({ offset: '1', limit: '1' }))).sessions.length, 1);
  await assert.rejects(f.service.historyList(new URLSearchParams({ limit: '0' })), { statusCode: 400 });
});
