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
import { createTaskCenter } from '../src/taskCenter.js';
import { RemoteCodexWorker } from '../src/remoteCodexWorker.js';
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
    return { projects: async () => ['codex', 'claude'].map(agent => ({ id: agent, agent, protocol: 'acp' as const, cwd: root, models: [{ id: 'test-model', name: 'Test Model', reasoningEfforts: [{ id: 'low', name: '低' }] }] })), start: async job => { launched.push(job); update({ ...job, status: 'running', sessionId: job.resumeSessionId || randomUUID() }); }, close() {} };
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
  assert.doesNotMatch(f.launched[0].prompt, /保持原接口兼容|TOOL_RESULT_/);
  assert.ok(f.launched[0].contextMarkdownPath);
  const handoff = await readFile(f.launched[0].contextMarkdownPath, 'utf8');
  const evidence = await readFile(path.join(f.root, 'context', `evidence-${f.launched[0].contextId}.json`), 'utf8');
  assert.match(handoff, /# 会话交接/); assert.match(handoff, /工具结果/); assert.ok(handoff.includes(long)); assert.ok(evidence.includes(long));
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

test('new conversation honors the selected project, directory, model and reasoning effort', async t => {
  const f = await fixture(t);
  const created = await f.service.create(f.source, {
    requestId: randomUUID(), targetAgent: 'codex', projectId: 'codex', cwd: f.root,
    model: 'test-model', reasoningEffort: 'low', message: '使用明确选择的运行配置'
  });
  await new Promise(resolve => setImmediate(resolve));
  const session = f.service.detail(created.sessionId).session;
  assert.equal(session.projectId, 'codex');
  assert.equal(session.model, 'test-model');
  assert.equal(session.reasoningEffort, 'low');
  assert.equal(session.cwd, await import('node:fs/promises').then(fs => fs.realpath(f.root)));
  assert.equal(f.launched[0].projectId, 'codex');
  assert.equal(f.launched[0].model, 'test-model');
  assert.equal(f.launched[0].reasoningEffort, 'low');
  assert.equal(f.launched[0].userMessage, '使用明确选择的运行配置');
  await assert.rejects(f.service.create(f.source, { requestId: randomUUID(), targetAgent: 'codex', projectId: 'claude' }), { statusCode: 400 });
});

test('switching back carries original context and new turns without nesting injected prompts', async t => {
  const f = await fixture(t);
  const a = await f.service.create(f.source, { requestId: randomUUID(), targetAgent: 'claude', message: '继续补测试' });
  await new Promise(resolve => setImmediate(resolve)); f.finish();
  const b = await f.service.create(a.sessionId, { requestId: randomUUID(), targetAgent: 'codex', message: '检查上面的结果' });
  await new Promise(resolve => setImmediate(resolve));
  const prompt = f.launched[1].prompt;
  const handoff = await readFile(f.launched[1].contextMarkdownPath!, 'utf8');
  for (const text of ['保持原接口兼容', '继续补测试', '已补充测试，全部通过']) assert.ok(handoff.includes(text));
  assert.match(prompt, /检查上面的结果/);
  assert.doesNotMatch(prompt, /保持原接口兼容|<inherited_context>/);
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
  assert.equal(f.launched.length, 2); assert.match(await readFile(f.launched[1].contextMarkdownPath!, 'utf8'), /最后完成修复/);
});

test('frozen context survives new service instances and source edits; tenant cannot read another context', async t => {
  const f = await fixture(t);
  const created = await f.service.create(f.source, { requestId: randomUUID(), targetAgent: 'claude' });
  await appendFile(f.file, line(message('交接后新增的消息')));
  const restarted = createConversations(f.options);
  await restarted.send(created.sessionId, { requestId: randomUUID(), message: '继续' });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(await readFile(f.launched[0].contextMarkdownPath!, 'utf8'), /交接后新增的消息/);
  const foreign = createConversations({ ...f.options, tenantId: 'other', history: { catalog: async () => ({ sessions: [] }) } });
  assert.throws(() => foreign.detail(created.sessionId), { statusCode: 404 });
  assert.throws(() => foreign.inherited(created.sessionId), { statusCode: 404 });
  await assert.rejects(foreign.create(created.sessionId, { requestId: randomUUID(), targetAgent: 'codex' }), { statusCode: 404 });
  assert.equal(f.database.readSessionContext('other', f.service.detail(created.sessionId).session.contextId), null);
});

test('single Markdown handoff keeps full source records without prompt compaction', async t => {
  const f = await fixture(t);
  const entries = Array.from({ length: 30 }, (_, i) => ({ role: 'assistant', text: `record-${i} ` + 'x'.repeat(500), source: f.source }));
  const snapshot = freezeContext(entries, [f.source]);
  const result = await contextPrompt(snapshot, '继续', path.join(f.root, 'context'), 3000);
  assert.equal(result.compacted, false); assert.match(result.prompt, /Markdown 交接文件/); assert.doesNotMatch(result.prompt, /record-29/);
  const handoff = await readFile(result.markdownPath, 'utf8');
  assert.match(handoff, /记录 15/); assert.match(handoff, /record-29/);
  const saved = JSON.parse(await readFile(path.join(f.root, 'context', `evidence-${snapshot.id}.json`), 'utf8'));
  assert.deepEqual(saved.entries, entries); assert.equal(saved.digest, snapshot.digest);
  await assert.rejects(contextPrompt(snapshot, '继续', path.join(f.root, 'context'), 3000, false), { statusCode: 422 });
});

test('delivery reads all pages and avoids duplicate Codex event messages', async t => {
  const f = await fixture(t);
  await appendFile(f.file, Array.from({ length: 220 }, (_, i) => line(message(`turn-${i}`))).join('') + line({ type: 'event_msg', payload: { type: 'user_message', message: 'turn-219' } }));
  const result = await readContext(f.delivery, f.source);
  assert.equal(result.entries.length, 222); assert.equal(result.entries.filter(e => e.text.includes('turn-219')).length, 1);
});

test('inherited context removes runtime envelopes while retaining user text and images', async t => {
  const f = await fixture(t), imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const image = `data:image/png;base64,${imageBytes.toString('base64')}`;
  await appendFile(f.file,
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>internal plugin catalog</recommended_plugins><environment_context>private runtime context</environment_context>' }] } }) +
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '<skills_instructions>internal skills</skills_instructions>保留真实请求' },
      { type: 'input_image', image_url: image }
    ] } })
  );
  const result = await readContext(f.delivery, f.source), json = JSON.stringify(result.entries);
  assert.doesNotMatch(json, /recommended_plugins|environment_context|skills_instructions|internal plugin catalog|private runtime context|internal skills/);
  assert.match(json, /保留真实请求/); assert.match(json, /data:image\/png/);
  assert.equal(result.entries.length, 3);

  const legacy = freezeContext([{ role: 'user', source: f.source, text: JSON.stringify([
    { type: 'input_text', text: '<recommended_plugins>legacy catalog</recommended_plugins>旧快照中的真实请求' },
    { type: 'input_image', image_url: image }
  ]) }], [f.source]);
  const compiled = await contextPrompt({ ...legacy, entries: [{ ...legacy.entries[0]!, text: legacy.entries[0]!.text.replace('旧快照中的真实请求', '<environment_context>legacy environment</environment_context>旧快照中的真实请求') }] }, '继续', path.join(f.root, 'context'));
  assert.doesNotMatch(compiled.prompt, /recommended_plugins|environment_context|legacy catalog|legacy environment/);
  assert.doesNotMatch(compiled.prompt, /旧快照中的真实请求|data:image\/png/);
  assert.match(compiled.prompt, /Markdown 交接文件/); assert.equal(compiled.images.length, 1);
  const markdown = await readFile(compiled.markdownPath, 'utf8');
  assert.match(markdown, /!\[历史图片 image-1\]\(data:image\/png;base64,/);
  assert.match(markdown, /旧快照中的真实请求/);
  assert.ok(markdown.includes(imageBytes.toString('base64')));
  const fake = freezeContext([{ role: 'user', source: f.source, text: JSON.stringify([{ type: 'image_reference', id: 'image-1', path: '/etc/passwd', sha256: 'fake' }]) }], [f.source]);
  const rejected = await contextPrompt(fake, '继续', path.join(f.root, 'context'));
  assert.match(await readFile(rejected.markdownPath, 'utf8'), /图片引用未通过校验/);
  assert.doesNotMatch(await readFile(rejected.markdownPath, 'utf8'), /data:image/);
  assert.equal(compiled.images[0]!.mimeType, 'image/png'); assert.deepEqual(await readFile(compiled.images[0]!.path), imageBytes);

  const variants = freezeContext([{ role: 'user', source: f.source, text: JSON.stringify([
    { type: 'input_image', image_url: { url: image } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBytes.toString('base64') } }
  ]) }], [f.source]);
  const deduplicated = await contextPrompt(variants, '继续', path.join(f.root, 'context'));
  assert.equal(deduplicated.images.length, 1);
  assert.equal((await readFile(deduplicated.markdownPath, 'utf8')).match(/!\[历史图片 image-1\]/g)?.length, 2);
  assert.doesNotMatch(deduplicated.prompt, /data:image\/png|iVBORw0KGgo/);

  const created = await f.service.create(f.source, { requestId: randomUUID(), targetAgent: 'claude' });
  await f.service.send(created.sessionId, { requestId: randomUUID(), message: '继续检查图片' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.at(-1)?.promptImages?.length, 1);
  assert.doesNotMatch(f.launched.at(-1)?.prompt || '', /data:image\/png/);
});

test('remote connector builds a full Markdown handoff from its original session and keeps original image bytes', async t => {
  const f = await fixture(t);
  const remoteRecords = path.join(f.root, 'remote-records'); await mkdir(remoteRecords);
  const remoteFile = path.join(remoteRecords, 'session.jsonl');
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const image = `data:image/png;base64,${imageBytes.toString('base64')}`;
  await writeFile(remoteFile, line({ type: 'session_meta', payload: { id: 'remote-native', cwd: f.root } }) +
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '远端完整原文' }, { type: 'input_image', image_url: image }] } }) +
    line(message('远端答复', 'assistant')));
  const remoteHistory = createAgentHistory({ environment: { IDE_HISTORY_CODEX_DIR: remoteRecords, IDE_HISTORY_CLAUDE_DIR: path.join(f.root, 'absent') }, workspace: () => f.root });
  const delivery = createSessionDelivery({ history: remoteHistory });
  const center = createTaskCenter({ database: f.database, tenantId: 'default', history: f.history });
  const owner = { id: 'remote-owner' };
  await center.command({ action: 'heartbeat', deviceId: 'remote', name: '远端设备', agents: ['codex'], codexProjects: [{ id: 'remote-project', name: '远端项目', cwd: f.root, agent: 'codex' }],
    sessions: [{ nativeId: 'remote-native', agent: 'codex', title: '远端会话', cwd: f.root, status: 'completed', excerpt: '', updatedAt: new Date().toISOString() }] }, owner);
  const source = (await center.snapshot()).sessions.find(session => session.deviceId === 'remote' && session.nativeId === 'remote-native');
  assert.ok(source);
  const created = await f.service.create(source.id, { requestId: randomUUID(), targetAgent: 'codex', projectId: 'remote-project', message: '继续远端任务' });
  const queued = f.database.readTaskCenter('default').executions.find(job => job.conversationId === created.sessionId);
  assert.ok(queued?.remoteContext); assert.equal(queued.contextMarkdownPath, undefined);
  const launchedJobs: Array<{ prompt?: string; contextMarkdownPath?: string; promptImages?: Array<{ path: string }> }> = [];
  const worker = new RemoteCodexWorker({ deviceId: 'remote', workspace: f.root, directory: path.join(f.root, 'remote-journal'),
    contextSource: { catalog: () => remoteHistory.catalog(), delivery },
    request: (method, body, endpoint) => {
      if (method === 'GET' && endpoint?.startsWith('/api/conversations/')) {
        const url = new URL(endpoint, 'http://localhost'); return f.service.inherited(url.pathname.split('/')[3]!, url.searchParams);
      }
      return method === 'GET' ? center.snapshot() : f.execution.action(body as Parameters<typeof f.execution.action>[0], owner);
    },
    runnerFactory: update => ({ projects: async () => [{ id: 'remote-project', cwd: f.root, agent: 'codex' }],
      start: async (job: RunnerJob) => { launchedJobs.push(job); update({ ...job, status: 'completed', sessionId: `remote-result-${launchedJobs.length}` }); },
      respond: async () => {}, stop: async () => {}, reconcile: async () => {}, close() {} }) });
  t.after(() => worker.close());
  await worker.sync();
  const launched = launchedJobs[0];
  assert.ok(launched?.contextMarkdownPath);
  assert.match(launched.prompt || '', /Markdown 交接文件/); assert.doesNotMatch(launched.prompt || '', /远端完整原文/);
  const markdown = await readFile(launched.contextMarkdownPath, 'utf8');
  assert.match(markdown, /远端完整原文|远端答复/); assert.match(markdown, /data:image\/png;base64,/);
  assert.ok(markdown.includes(imageBytes.toString('base64')));
  assert.equal(launched.promptImages?.length, 1);
  assert.deepEqual(await readFile(launched.promptImages![0]!.path), imageBytes);
  await worker.sync();
  assert.equal(f.database.readTaskCenter('default').executions.find(job => job.conversationId === created.sessionId)?.status, 'completed');
  assert.equal(f.service.detail(created.sessionId).session.partial, false);
  await appendFile(remoteFile, line(message('冻结后新增内容')));
  const switched = await f.service.create(created.sessionId, { requestId: randomUUID(), targetAgent: 'codex', projectId: 'remote-project', message: '切换后继续' });
  await worker.sync();
  const switchedJob = launchedJobs[1];
  assert.ok(switchedJob?.contextMarkdownPath);
  const switchedMarkdown = await readFile(switchedJob.contextMarkdownPath, 'utf8');
  assert.match(switchedMarkdown, /远端完整原文|继续远端任务/);
  assert.doesNotMatch(switchedMarkdown, /冻结后新增内容/);
  assert.equal(f.database.readTaskCenter('default').executions.find(job => job.conversationId === switched.sessionId)?.status, 'completed');
  await rm(path.join(f.root, 'remote-journal', 'context', `source-${created.sessionId}.json`));
  const lost = await f.service.create(switched.sessionId, { requestId: randomUUID(), targetAgent: 'codex', projectId: 'remote-project', message: '继续冻结链' });
  await worker.sync();
  assert.equal(launchedJobs.length, 2);
  assert.match(f.database.readTaskCenter('default').executions.find(job => job.conversationId === lost.sessionId)?.message || '', /冻结来源已丢失/);
  await center.command({ action: 'heartbeat', deviceId: 'remote', name: '远端设备', agents: ['codex'],
    sessions: [{ nativeId: 'missing-native', agent: 'codex', title: '已丢失的会话', cwd: f.root, status: 'completed', excerpt: '仅有不完整摘要', updatedAt: new Date().toISOString() }] }, owner);
  const missing = (await center.snapshot()).sessions.find(session => session.deviceId === 'remote' && session.nativeId === 'missing-native');
  assert.ok(missing);
  const failed = await f.service.create(missing.id, { requestId: randomUUID(), targetAgent: 'codex', projectId: 'remote-project', message: '不要用摘要冒充原始记录' });
  await worker.sync();
  assert.equal(launchedJobs.length, 2);
  const failedJob = f.database.readTaskCenter('default').executions.find(job => job.conversationId === failed.sessionId);
  assert.equal(failedJob?.status, 'failed'); assert.match(failedJob?.message || '', /原始会话不存在/);
  await worker.sync(); assert.equal(launchedJobs.length, 2);
});

test('cross-device A to B waits for the source packet and runs in B selected directory with original image bytes', async t => {
  const f = await fixture(t), dirA = path.join(f.root, 'device-a'), dirB = path.join(f.root, 'device-b');
  await mkdir(dirA); await mkdir(dirB);
  const records = path.join(f.root, 'device-a-records'); await mkdir(records);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(records, 'session.jsonl'), line({ type: 'session_meta', payload: { id: 'a-native', cwd: dirA } }) +
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A 的完整需求' }, { type: 'input_image', image_url: `data:image/png;base64,${bytes.toString('base64')}` }] } }) +
    line(message('A 的回复', 'assistant')));
  const historyA = createAgentHistory({ environment: { IDE_HISTORY_CODEX_DIR: records, IDE_HISTORY_CLAUDE_DIR: path.join(f.root, 'absent') }, workspace: () => dirA });
  const deliveryA = createSessionDelivery({ history: historyA });
  const center = createTaskCenter({ database: f.database, tenantId: 'default', history: f.history });
  const actorA = { id: 'connector-a' }, actorB = { id: 'connector-b' };
  for (const [deviceId, actor, cwd] of [['A', actorA, dirA], ['B', actorB, dirB]] as const) {
    await center.command({ action: 'heartbeat', deviceId, name: deviceId, agents: ['codex'], codexProjects: [{ id: `project-${deviceId}`, name: deviceId, cwd, agent: 'codex' }],
      sessions: deviceId === 'A' ? [{ nativeId: 'a-native', agent: 'codex', title: 'A 的会话', cwd, status: 'completed', excerpt: '', updatedAt: new Date().toISOString() }] : [] }, actor);
  }
  const source = (await center.snapshot()).sessions.find(session => session.deviceId === 'A' && session.nativeId === 'a-native');
  assert.ok(source);
  await assert.rejects(f.service.create(source.id, { requestId: randomUUID(), targetAgent: 'codex', deviceId: 'B', projectId: 'project-B', message: 'B 继续' }), { statusCode: 400 });
  const created = await f.service.create(source.id, { requestId: randomUUID(), targetAgent: 'codex', deviceId: 'B', projectId: 'project-B', cwd: dirB, message: 'B 继续' });
  const queued = f.database.readTaskCenter('default').executions.find(job => job.conversationId === created.sessionId);
  assert.ok(queued); assert.equal(queued.contextSourceDeviceId, 'A'); assert.equal(queued.deviceId, 'B');
  let uploadedManifestDigest = '';
  const route = (actor: { id: string }, deviceId: string) => (method: string, body?: unknown, endpoint?: string) => {
    if (endpoint?.includes('/transfer/objects/')) {
      const url = new URL(endpoint, 'http://localhost');
      const result = f.service.transferObject(url.pathname.split('/')[3]!, url.searchParams.get('executionId') || '', method === 'POST' ? 'upload' : 'read', actor,
        { deviceId, digest: url.pathname.split('/').at(-1)!, mimeType: url.searchParams.get('mimeType') || '', data: body instanceof Uint8Array ? body : undefined });
      return 'bytes' in result ? result.bytes : result;
    }
    if (endpoint?.includes('/transfer')) {
      const url = new URL(endpoint, 'http://localhost');
      const input = method === 'POST' ? body as Record<string, unknown> : { deviceId, readyOnly: url.searchParams.get('readyOnly'), format: url.searchParams.get('format') };
      if (method === 'POST' && 'manifest' in input) uploadedManifestDigest = String((input.manifest as { manifestDigest?: unknown }).manifestDigest || '');
      return f.service.transfer(url.pathname.split('/')[3]!, String(method === 'POST' ? input.executionId : url.searchParams.get('executionId')), method === 'POST' ? 'upload' : 'read', actor, input);
    }
    if (method === 'GET' && endpoint?.includes('/inherited')) {
      const url = new URL(endpoint, 'http://localhost'); return f.service.inherited(url.pathname.split('/')[3]!, url.searchParams);
    }
    return method === 'GET' ? center.snapshot() : f.execution.action(body as Parameters<typeof f.execution.action>[0], actor);
  };
  const launched: RunnerJob[] = [], launchedA: RunnerJob[] = [];
  const workerA = new RemoteCodexWorker({ deviceId: 'A', workspace: dirA, directory: path.join(f.root, 'journal-a'), contextSource: { catalog: () => historyA.catalog(), delivery: deliveryA }, request: route(actorA, 'A'),
    runnerFactory: update => ({ projects: async () => [{ id: 'project-A', cwd: dirA, agent: 'codex' }], start: async (job: RunnerJob) => { launchedA.push(job); update({ ...job, status: 'completed', sessionId: 'a-result' }); }, respond: async () => {}, stop: async () => {}, reconcile: async () => {}, close() {} }) });
  const workerB = new RemoteCodexWorker({ deviceId: 'B', workspace: dirB, directory: path.join(f.root, 'journal-b'), request: route(actorB, 'B'),
    runnerFactory: update => ({ projects: async () => [{ id: 'project-B', cwd: dirB, agent: 'codex' }], start: async (job: RunnerJob) => { launched.push(job); update({ ...job, status: 'completed', sessionId: 'b-native' }); }, respond: async () => {}, stop: async () => {}, reconcile: async () => {}, close() {} }) });
  t.after(() => { workerA.close(); workerB.close(); });
  await workerB.sync(); assert.equal(launched.length, 0);
  assert.deepEqual(f.service.transfer(created.sessionId, queued.id, 'read', actorB, { deviceId: 'B', readyOnly: '1' }), { ready: false });
  assert.throws(() => f.service.transfer(created.sessionId, queued.id, 'read', actorA, { deviceId: 'B' }), { statusCode: 403 });
  assert.throws(() => f.service.transfer(created.sessionId, queued.id, 'upload', actorB, { deviceId: 'A' }), { statusCode: 403 });
  await workerA.sync(); await workerB.sync();
  assert.equal(launched.length, 1, JSON.stringify(f.database.readTaskCenter('default').executions.find(job => job.id === queued.id))); assert.equal(launched[0]!.cwd, dirB);
  const foreign = createConversations({ ...f.options, tenantId: 'other' });
  assert.throws(() => foreign.transfer(created.sessionId, queued.id, 'read', actorB, { deviceId: 'B' }), { statusCode: 404 });
  const savedPacket = f.service.transfer(created.sessionId, queued.id, 'read', actorB, { deviceId: 'B' });
  assert.ok('context' in savedPacket && savedPacket.context);
  const v2Packet = f.service.transfer(created.sessionId, queued.id, 'read', actorB, { deviceId: 'B', format: 'bundle-v2' });
  assert.ok('bundle' in v2Packet && v2Packet.bundle);
  assert.equal('context' in v2Packet, false);
  const v3Packet = f.service.transfer(created.sessionId, queued.id, 'read', actorB, { deviceId: 'B', format: 'manifest-v3' });
  assert.ok('manifest' in v3Packet && v3Packet.manifest);
  assert.equal(v3Packet.manifest.manifestDigest, uploadedManifestDigest);
  const objectDigest = v3Packet.manifest.objects[0]?.digest;
  assert.ok(objectDigest);
  const deliveredObject = f.service.transferObject(created.sessionId, queued.id, 'read', actorB, { deviceId: 'B', digest: objectDigest });
  assert.ok('bytes' in deliveredObject && deliveredObject.bytes);
  assert.deepEqual(Buffer.from(deliveredObject.bytes), bytes);
  assert.throws(() => f.service.transferObject(created.sessionId, queued.id, 'read', actorA, { deviceId: 'B', digest: objectDigest }), { statusCode: 403 });
  assert.throws(() => f.service.transferObject(created.sessionId, queued.id, 'upload', actorB, { deviceId: 'A', digest: objectDigest, mimeType: 'image/png', data: bytes }), { statusCode: 403 });
  assert.throws(() => foreign.transferObject(created.sessionId, queued.id, 'read', actorB, { deviceId: 'B', digest: objectDigest }), { statusCode: 404 });
  assert.throws(() => f.service.transferObject(created.sessionId, queued.id, 'upload', actorA, { deviceId: 'A', digest: objectDigest, mimeType: 'image/png', data: Buffer.from('changed') }), { statusCode: 400 });
  const changed = freezeContext([...savedPacket.context.entries, { role: 'assistant', text: '伪造变更', source: source.id }], savedPacket.context.sources);
  assert.throws(() => f.service.transfer(created.sessionId, queued.id, 'upload', actorA, { deviceId: 'A', context: changed }), { statusCode: 409 });
  assert.match(launched[0]!.prompt, /Markdown 交接文件/);
  const markdown = await readFile(launched[0]!.contextMarkdownPath!, 'utf8');
  assert.match(markdown, /A 的完整需求/); assert.ok(markdown.includes(bytes.toString('base64')));
  assert.deepEqual(await readFile(launched[0]!.promptImages![0]!.path), bytes);
  await workerA.sync(); await workerB.sync(); assert.equal(launched.length, 1);
  assert.equal(f.database.readTaskCenter('default').executions.find(job => job.id === queued.id)?.status, 'completed');
  await rm(path.join(records, 'session.jsonl'));
  const returned = await f.service.create(created.sessionId, { requestId: randomUUID(), targetAgent: 'codex', deviceId: 'A', projectId: 'project-A', cwd: dirA, message: '带上 B 的结果返回 A' });
  const returnJob = f.database.readTaskCenter('default').executions.find(job => job.conversationId === returned.sessionId);
  assert.equal(returnJob?.contextSourceDeviceId, 'local');
  await workerA.sync(); assert.equal(launchedA.length, 1);
  assert.match(await readFile(launchedA[0]!.contextMarkdownPath!, 'utf8'), /A 的完整需求|B 继续/);
  await center.command({ action: 'heartbeat', deviceId: 'A', name: 'A', agents: ['codex'], sessions: [{ nativeId: 'missing-native', agent: 'codex', title: '不可读取来源', cwd: dirA, status: 'completed', excerpt: '', updatedAt: new Date().toISOString() }] }, actorA);
  const missingSource = (await center.snapshot()).sessions.find(item => item.deviceId === 'A' && item.nativeId === 'missing-native'); assert.ok(missingSource);
  const failed = await f.service.create(missingSource.id, { requestId: randomUUID(), targetAgent: 'codex', deviceId: 'B', projectId: 'project-B', cwd: dirB, message: '不得用摘要代替' });
  await workerA.sync(); await workerB.sync();
  const failedJob = f.database.readTaskCenter('default').executions.find(item => item.conversationId === failed.sessionId);
  assert.equal(failedJob?.status, 'failed'); assert.match(failedJob.message || '', /原始会话不存在/); assert.equal(launched.length, 1);
});

test('local source can hand its frozen context to a remote device without copying the repository', async t => {
  const f = await fixture(t), target = path.join(f.root, 'target'), selected = path.join(f.root, 'selected-repo'); await mkdir(target); await mkdir(selected);
  const center = createTaskCenter({ database: f.database, tenantId: 'default', history: f.history }), actor = { id: 'connector-b' }, requester = { id: 'requester' };
  await center.command({ action: 'heartbeat', deviceId: 'B', name: 'B', agents: ['codex'], codexProjects: [{ id: 'codex', name: 'B', cwd: target, agent: 'codex' }], sessions: [] }, actor);
  await assert.rejects(f.service.create(f.source, { requestId: randomUUID(), targetAgent: 'codex', deviceId: 'B', projectId: 'codex', cwd: selected, message: '在 B 上继续' }, requester), { statusCode: 409 });
  const choice = await f.execution.pickDirectory({ deviceId: 'B', projectId: 'codex' }, requester);
  assert.equal(choice.status, 'pending'); assert.ok('requestId' in choice);
  await f.execution.directoryAction({ action: 'claim', requestId: choice.requestId }, actor);
  await f.execution.directoryAction({ action: 'report', requestId: choice.requestId, cwd: selected }, actor);
  await assert.rejects(f.service.create(f.source, { requestId: randomUUID(), targetAgent: 'codex', deviceId: 'B', projectId: 'codex', cwd: selected, directoryRequestId: choice.requestId, message: '在 B 上继续' }, { id: 'other' }), { statusCode: 409 });
  const created = await f.service.create(f.source, { requestId: randomUUID(), targetAgent: 'codex', deviceId: 'B', projectId: 'codex', cwd: selected, directoryRequestId: choice.requestId, message: '在 B 上继续' }, requester);
  const job = f.database.readTaskCenter('default').executions.find(item => item.conversationId === created.sessionId);
  assert.ok(job); assert.equal(job.contextSourceDeviceId, 'local'); assert.equal(job.deviceId, 'B');
  const packet = f.service.transfer(created.sessionId, job.id, 'read', actor, { deviceId: 'B' });
  assert.equal(packet.ready, true); assert.match(JSON.stringify(packet), /保持原接口兼容/);
  const launched: RunnerJob[] = [];
  const worker = new RemoteCodexWorker({ deviceId: 'B', workspace: selected, directory: path.join(f.root, 'journal-b'),
    request: (method, body, endpoint) => endpoint?.includes('/transfer') ? f.service.transfer(created.sessionId, job.id, 'read', actor, { deviceId: 'B', readyOnly: new URL(endpoint, 'http://localhost').searchParams.get('readyOnly') }) : method === 'GET' ? center.snapshot() : f.execution.action(body as Parameters<typeof f.execution.action>[0], actor),
    runnerFactory: update => ({ projects: async () => [{ id: 'codex', cwd: target, agent: 'codex' }], start: async (item: RunnerJob) => { launched.push(item); update({ ...item, status: 'completed', sessionId: 'b-native' }); }, respond: async () => {}, stop: async () => {}, reconcile: async () => {}, close() {} }) });
  t.after(() => worker.close()); await worker.sync();
  assert.equal(launched.length, 1); assert.equal(launched[0]!.cwd, selected); assert.match(await readFile(launched[0]!.contextMarkdownPath!, 'utf8'), /保持原接口兼容/);
});

test('remote source to workbench device waits for upload before launching once', async t => {
  const f = await fixture(t), records = path.join(f.root, 'remote-source'); await mkdir(records);
  await writeFile(path.join(records, 'session.jsonl'), line({ type: 'session_meta', payload: { id: 'remote-native', cwd: f.root } }) + line(message('A 设备原文')));
  const historyA = createAgentHistory({ environment: { IDE_HISTORY_CODEX_DIR: records, IDE_HISTORY_CLAUDE_DIR: path.join(f.root, 'absent') }, workspace: () => f.root });
  const center = createTaskCenter({ database: f.database, tenantId: 'default', history: f.history }), actorA = { id: 'connector-a' };
  await center.command({ action: 'heartbeat', deviceId: 'A', name: 'A', agents: ['codex'], codexProjects: [{ id: 'project-A', name: 'A', cwd: f.root, agent: 'codex' }],
    sessions: [{ nativeId: 'remote-native', agent: 'codex', title: 'A 的会话', cwd: f.root, status: 'completed', excerpt: '', updatedAt: new Date().toISOString() }] }, actorA);
  const source = (await center.snapshot()).sessions.find(item => item.deviceId === 'A' && item.nativeId === 'remote-native'); assert.ok(source);
  const created = await f.service.create(source.id, { requestId: randomUUID(), targetAgent: 'codex', deviceId: 'local', projectId: 'codex', cwd: f.root, message: '在工作台设备继续' });
  assert.equal(f.launched.length, 0); await f.service.preparePending(); assert.equal(f.launched.length, 0);
  const worker = new RemoteCodexWorker({ deviceId: 'A', workspace: f.root, directory: path.join(f.root, 'journal-a'), contextSource: { catalog: () => historyA.catalog(), delivery: createSessionDelivery({ history: historyA }) },
    request: (method, body, endpoint) => {
      if (endpoint?.includes('/transfer/objects/')) {
        const url = new URL(endpoint, 'http://localhost');
        return f.service.transferObject(created.sessionId, url.searchParams.get('executionId') || '', 'upload', actorA,
          { deviceId: 'A', digest: url.pathname.split('/').at(-1)!, mimeType: url.searchParams.get('mimeType') || '', data: body as Uint8Array });
      }
      if (endpoint?.includes('/transfer')) return f.service.transfer(created.sessionId, String((body as Record<string, unknown>).executionId), 'upload', actorA, body as Record<string, unknown>);
      if (method === 'GET' && endpoint?.includes('/inherited')) return f.service.inherited(created.sessionId, new URL(endpoint, 'http://localhost').searchParams);
      return center.snapshot();
    }, runnerFactory: () => ({ projects: async () => [{ id: 'project-A', cwd: f.root, agent: 'codex' }], start: async () => {}, respond: async () => {}, stop: async () => {}, reconcile: async () => {}, close() {} }) });
  t.after(() => worker.close()); await worker.sync(); await f.service.preparePending(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.length, 1); assert.match(await readFile(f.launched[0]!.contextMarkdownPath!, 'utf8'), /A 设备原文/);
  await f.service.preparePending(); assert.equal(f.launched.length, 1);
});

test('new routes explicitly separate execution and read permissions', () => {
  const id = 'a'.repeat(64);
  assert.equal(permissionForRoute('POST', `/api/sessions/${id}/continue-as-new`), 'work.execute');
  assert.equal(permissionForRoute('GET', `/api/conversations/${id}/inherited`), 'read');
  assert.equal(permissionForRoute('GET', `/api/conversations/${id}/transfer`), 'work.execute');
  assert.equal(permissionForRoute('POST', `/api/conversations/${id}/transfer`), 'work.execute');
  assert.equal(permissionForRoute('GET', `/api/conversations/${id}/transfer/objects/${id}`), 'work.execute');
  assert.equal(permissionForRoute('POST', `/api/conversations/${id}/transfer/objects/${id}`), 'work.execute');
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
