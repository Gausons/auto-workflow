import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { AcpAgentConnection, AcpPreferredRunner, AcpTaskRunner, AgentRunnerSet, configuredAcpAgents, resolveAcpLaunch } from '../src/acpAgent.js';
import type { Execution } from '../public/taskTypes.js';

interface TestJob {
  id: string; agent?: string; protocol?: string; projectId?: string; status?: string; sessionId?: string | null;
  resumeSessionId?: string; conversationId?: string; cwd?: string; prompt?: string; title?: string; output?: string;
  model?: string | null; reasoningEffort?: string | null; desktopOpened?: boolean; message?: string;
  [key: string]: unknown;
}

test('resolves ACP for built-in and custom agents and supports explicit opt-out', () => {
  assert.deepEqual(resolveAcpLaunch('codex', {}), { command: 'codex-acp', args: [] });
  assert.deepEqual(resolveAcpLaunch('claude', { ACP_CLAUDE_EXECUTABLE: '/bin/claude-acp', ACP_CLAUDE_ARGS: '["--stdio"]' }), { command: '/bin/claude-acp', args: ['--stdio'] });
  assert.deepEqual(resolveAcpLaunch('gemini', { ACP_GEMINI_EXECUTABLE: 'gemini', ACP_GEMINI_ARGS: '["--acp"]' }), { command: 'gemini', args: ['--acp'] });
  assert.equal(resolveAcpLaunch('codex', { ACP_ENABLED: 'false' }), null);
  assert.throws(() => resolveAcpLaunch('custom', { ACP_CUSTOM_EXECUTABLE: 'agent', ACP_CUSTOM_ARGS: 'bad' }), /JSON/);
});

test('enumerates built-in and configured ACP Agents without duplicate targets', async () => {
  assert.deepEqual(configuredAcpAgents({ ACP_AGENTS: 'claude,my-agent,codex' }), ['codex', 'claude', 'my-agent']);
  const starts: TestJob[] = [];
  const available = { projects: async () => [{ id: 'acp:codex', agent: 'codex' }], start: async (job: TestJob) => starts.push(job), close() {} };
  const unavailable = { projects: async () => { throw new Error('unavailable'); }, close() {} };
  const set = new AgentRunnerSet([['codex', available], ['claude', unavailable]]);
  assert.deepEqual(await set.projects('/repo'), [{ id: 'acp:codex', agent: 'codex' }]);
  await set.start({ id: 'job', agent: 'codex' });
  assert.equal(starts.length, 1); set.close();
});

test('performs a real ACP v1 initialize, session/new, session/prompt and update exchange', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bugflow-acp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = pathToFileURL(path.resolve('node_modules/@agentclientprotocol/sdk/dist/acp.js')).href;
  const agentFile = path.join(root, 'agent.mjs');
  await writeFile(agentFile, `
    import { Readable, Writable } from 'node:stream';
    import * as acp from ${JSON.stringify(sdk)};
    const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
    const configOptions = [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'Model 1' }, { value: 'm2', name: 'Model 2' }] },
      { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }
    ];
    acp.agent({ name: 'fixture' })
      .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { promptCapabilities: { image: true } }, authMethods: [], agentInfo: { name: 'fixture', version: '1' } }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'session-fixture', configOptions }))
      .onRequest(acp.methods.agent.session.setConfigOption, () => ({ configOptions }))
      .onRequest(acp.methods.agent.session.prompt, async ctx => {
        const permission = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: { toolCallId: 'tool-1', title: '修改文件', kind: 'edit', status: 'pending' },
          options: [{ optionId: 'yes', name: '允许一次', kind: 'allow_once' }, { optionId: 'no', name: '拒绝', kind: 'reject_once' }]
        });
        const selected = permission.outcome.outcome === 'selected' ? permission.outcome.optionId : 'cancelled';
        const kinds = ctx.params.prompt.map(block => block.type).join(',');
        await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP 完成:' + selected + ':' + kinds } } });
        return { stopReason: 'end_turn' };
      })
      .onNotification(acp.methods.agent.session.cancel, () => {})
      .connect(stream);
  `);
  const connection = new AcpAgentConnection({ agent: 'fixture', launch: { command: process.execPath, args: [agentFile] }, environment: process.env });
  t.after(() => connection.close());
  const updates: Array<{ update: { content: { text: string } } }> = []; connection.on('update', update => updates.push(update));
  connection.on('permission', () => connection.respond('accept'));
  const initialized = await connection.initialize();
  assert.equal(initialized.protocolVersion, 1);
  const session = await connection.newSession(root); assert.equal(session.sessionId, 'session-fixture');
  await connection.configure(session, 'm2', 'high');
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const image = path.join(root, 'history.png'); await writeFile(image, imageBytes);
  const markdown = path.join(root, 'handoff.md'); await writeFile(markdown, '# 会话交接\n\n原始图片已内嵌');
  const sha256 = (await import('node:crypto')).createHash('sha256').update(imageBytes).digest('hex');
  assert.deepEqual(await connection.prompt('执行', [{ id: 'image-1', path: image, mimeType: 'image/png', sha256, size: imageBytes.length }], markdown), { stopReason: 'end_turn' });
  assert.equal(updates[0].update.content.text, 'ACP 完成:yes:text,resource_link,text,image');

});

test('ACP preferred runner only falls back when ACP is unavailable', async () => {
  const calls: string[] = [];
  const preferred = new AcpPreferredRunner({
    primary: { projects: async () => { calls.push('acp'); return [{ id: 'acp:codex', protocol: 'acp' }]; }, start: async () => {}, close() {} },
    fallback: { projects: async () => { calls.push('legacy'); return []; }, start: async () => {}, close() {} }
  });
  assert.equal((await preferred.projects('/repo'))[0].protocol, 'acp');
  assert.deepEqual(calls, ['acp']);

  const fallbackCalls: string[] = [];
  const fallback = new AcpPreferredRunner({
    primary: { projects: async () => { fallbackCalls.push('acp'); throw Object.assign(new Error(), { code: 'ACP_UNAVAILABLE' }); }, close() {} },
    fallback: { projects: async () => { fallbackCalls.push('legacy'); return [{ id: 'legacy' }]; }, close() {} }
  });
  assert.equal((await fallback.projects('/repo'))[0].id, 'legacy');
  assert.deepEqual(fallbackCalls, ['acp', 'legacy']);

  let started: TestJob | undefined;
  const startFallback = new AcpPreferredRunner({
    primary: { start: async () => { throw Object.assign(new Error('handshake failed'), { code: 'ACP_UNAVAILABLE' }); }, close() {} },
    fallback: { start: async (job: TestJob) => { started = job; return job; }, close() {} }
  });
  await startFallback.start({ id: 'job', protocol: 'acp', projectId: 'acp:codex', agent: 'codex' });
  assert.equal(started?.protocol, 'legacy'); assert.equal(started?.projectId, undefined);
});

test('Codex ACP uses the desktop model catalog and routes unsupported new models through App Server', async () => {
  const primaryStarts: TestJob[] = [], fallbackStarts: TestJob[] = [];
  const preferred = new AcpPreferredRunner({
    synchronizeModels: true,
    primary: {
      projects: async () => [{ id: 'acp:codex', cwd: '/repo', protocol: 'acp', models: [{ id: 'gpt-6-astra', name: '6 Astra' }], defaultModel: 'gpt-5.6-sol' }],
      start: async (job: TestJob) => { primaryStarts.push(job); }, close() {}
    },
    fallback: {
      projects: async () => [{ id: 'workspace:repo', cwd: '/repo', protocol: 'legacy', appServerProjectId: null, models: [{ id: 'gpt-6-astra', name: 'GPT-6-Astra' }, { id: 'gpt-6-sol', name: 'GPT-6-Sol' }], defaultModel: 'gpt-6-astra' }],
      start: async (job: TestJob) => { fallbackStarts.push(job); }, close() {}
    }
  });
  const [project] = await preferred.projects('/repo');
  assert.equal(project.id, 'acp:codex');
  assert.equal(project.defaultModel, 'gpt-6-astra');
  assert.deepEqual(project.models?.map(model => model.id), ['gpt-6-astra', 'gpt-6-sol']);

  await preferred.start({ id: 'default-model', protocol: 'acp', projectId: project.id, model: '', agent: 'codex' });
  assert.equal(primaryStarts[0]?.model, 'gpt-6-astra', 'ACP receives the synchronized desktop default explicitly');
  await preferred.start({ id: 'new-model', protocol: 'acp', projectId: project.id, model: 'gpt-6-sol', agent: 'codex' });
  assert.equal(fallbackStarts[0]?.protocol, 'legacy');
  assert.equal(fallbackStarts[0]?.projectId, undefined);
  assert.equal(fallbackStarts[0]?.model, 'gpt-6-sol');
});

test('Codex ACP task sessions are named and opened in the desktop client', async () => {
  const nativeId = '12345678-1234-1234-1234-123456789abc';
  class FakeConnection extends EventEmitter {
    promptStarted = false; closed = false; configured?: [string | undefined, string | undefined]; promptImages = 0;
    async initialize() { return { protocolVersion: 1 }; }
    async newSession() { return { sessionId: nativeId }; }
    async configure(_session: unknown, model?: string, effort?: string) { this.configured = [model, effort]; return []; }
    supportsImages() { return false; }
    async prompt(_text: string, images: unknown[] = []) { this.promptStarted = true; this.promptImages = images.length; return { stopReason: 'end_turn' }; }
    close() { this.closed = true; }
  }
  const named: Array<[string, string]> = [], opened: Array<[string]> = [], updates: Execution[] = [], fake = new FakeConnection();
  const runner = new AcpTaskRunner({
    agent: 'codex', environment: {}, connectionFactory: () => fake, onUpdate: job => updates.push(job),
    threadNamer: async (threadId: string, name: string) => { named.push([threadId, name]); }, desktopOpener: async (threadId: string) => { opened.push([threadId]); }
  });
  await runner.start({ id: 'job', agent: 'codex', agentLabel: 'Codex', title: '桌面任务', cwd: process.cwd(), prompt: '执行', promptImages: [{ id: 'image-1', path: '/tmp/image.png', mimeType: 'image/png', sha256: 'a'.repeat(64), size: 5 }], model: 'm2', reasoningEffort: 'high', status: 'queued' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(named, [[nativeId, '桌面任务']]); assert.deepEqual(opened, [[nativeId]]);
  assert.deepEqual(fake.configured, ['m2', 'high']);
  assert.equal(fake.promptImages, 1);
  assert.equal(updates.some(job => job.contextImageDelivery === 'file-reference'), true);
  assert.equal(updates.some(job => job.desktopOpened === true), true);
});

test('managed ACP conversations reuse live sessions and load after reconnect without replaying old output', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'acp-conversation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = new URL('./fixtures/conversation-agent.mjs', import.meta.url);
  const updates: Execution[] = [];
  const runner = new AcpTaskRunner({ agent: 'claude', environment: { ...process.env, ACP_CLAUDE_EXECUTABLE: process.execPath, ACP_CLAUDE_ARGS: JSON.stringify([fixture.pathname]) }, onUpdate: job => updates.push(job) });
  t.after(() => runner.close());
  async function run(input: TestJob): Promise<Execution> {
    await runner.start(input);
    for (let i = 0; i < 100; i++) {
      const job = updates.filter(j => j.id === input.id).at(-1);
      if (job?.status === 'completed') return job;
      assert.ok(!job?.status || !['failed', 'unknown'].includes(job.status), job?.message);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('turn timeout');
  }
  const base = { agent: 'claude', conversationId: 'managed', cwd: root, prompt: 'hello', protocol: 'acp' };
  const first = await run({ ...base, id: 'one' });
  assert.ok(first.sessionId);
  const second = await run({ ...base, id: 'two', resumeSessionId: first.sessionId });
  assert.equal(first.sessionId, second.sessionId); assert.match(second.output || '', /第 2 轮/);
  runner.close();
  const third = await run({ ...base, id: 'three', resumeSessionId: first.sessionId });
  assert.equal(third.sessionId, first.sessionId); assert.doesNotMatch(third.output || '', /REPLAY_SHOULD_NOT_APPEAR/);
});

test('uncertain managed ACP session creation never falls back to creating another session', async () => {
  class UncertainConnection extends EventEmitter {
    sessionId = null; closed = false; promptStarted = false;
    async initialize() {}
    async newSession() { throw new Error('session/new response lost'); }
    close() { this.closed = true; }
  }
  const updates: Execution[] = [];
  const primary = new AcpTaskRunner({ agent: 'codex', connectionFactory: () => new UncertainConnection(), onUpdate: job => updates.push(job) });
  let fallbackStarts = 0;
  const runner = new AcpPreferredRunner({ primary, fallback: { start() { fallbackStarts++; }, close() {} } });
  await runner.start({ id: 'uncertain', agent: 'codex', protocol: 'acp', conversationId: 'managed', cwd: '/repo', prompt: 'continue' });
  assert.equal(updates.at(-1)?.status, 'unknown'); assert.equal(fallbackStarts, 0); runner.close();
});
