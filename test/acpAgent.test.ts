import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { AcpAgentConnection, AcpPreferredRunner, AcpTaskRunner, AgentRunnerSet, configuredAcpAgents, resolveAcpLaunch, spawnAcpPreferredAgent } from '../src/acpAgent.js';

test('resolves ACP for built-in and custom agents and supports explicit opt-out', () => {
  assert.deepEqual(resolveAcpLaunch('codex', {}), { command: 'codex-acp', args: [] });
  assert.deepEqual(resolveAcpLaunch('claude', { ACP_CLAUDE_EXECUTABLE: '/bin/claude-acp', ACP_CLAUDE_ARGS: '["--stdio"]' }), { command: '/bin/claude-acp', args: ['--stdio'] });
  assert.deepEqual(resolveAcpLaunch('gemini', { ACP_GEMINI_EXECUTABLE: 'gemini', ACP_GEMINI_ARGS: '["--acp"]' }), { command: 'gemini', args: ['--acp'] });
  assert.equal(resolveAcpLaunch('codex', { ACP_ENABLED: 'false' }), null);
  assert.throws(() => resolveAcpLaunch('custom', { ACP_CUSTOM_EXECUTABLE: 'agent', ACP_CUSTOM_ARGS: 'bad' }), /JSON/);
});

test('enumerates built-in and configured ACP Agents without duplicate targets', async () => {
  assert.deepEqual(configuredAcpAgents({ ACP_AGENTS: 'claude,my-agent,codex' }), ['codex', 'claude', 'my-agent']);
  const starts: any[] = [];
  const available = { projects: async () => [{ id: 'acp:codex', agent: 'codex' }], start: async (job: any) => starts.push(job), close() {} };
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
      .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [], agentInfo: { name: 'fixture', version: '1' } }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'session-fixture', configOptions }))
      .onRequest(acp.methods.agent.session.setConfigOption, () => ({ configOptions }))
      .onRequest(acp.methods.agent.session.prompt, async ctx => {
        const permission = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: { toolCallId: 'tool-1', title: '修改文件', kind: 'edit', status: 'pending' },
          options: [{ optionId: 'yes', name: '允许一次', kind: 'allow_once' }, { optionId: 'no', name: '拒绝', kind: 'reject_once' }]
        });
        const selected = permission.outcome.outcome === 'selected' ? permission.outcome.optionId : 'cancelled';
        await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP 完成:' + selected } } });
        return { stopReason: 'end_turn' };
      })
      .onNotification(acp.methods.agent.session.cancel, () => {})
      .connect(stream);
  `);
  const connection = new AcpAgentConnection({ agent: 'fixture', launch: { command: process.execPath, args: [agentFile] }, environment: process.env });
  t.after(() => connection.close());
  const updates: any[] = []; connection.on('update', update => updates.push(update));
  connection.on('permission', () => connection.respond('accept'));
  const initialized: any = await connection.initialize();
  assert.equal(initialized.protocolVersion, 1);
  const session = await connection.newSession(root); assert.equal(session.sessionId, 'session-fixture');
  await connection.configure(session, 'm2', 'high');
  assert.deepEqual(await connection.prompt('执行'), { stopReason: 'end_turn' });
  assert.equal(updates[0].update.content.text, 'ACP 完成:yes');

  let fallbackStarted = false, output = '';
  const childFacade: any = spawnAcpPreferredAgent({
    agent: 'fixture', cwd: root, prompt: '执行',
    environment: { ...process.env, ACP_FIXTURE_EXECUTABLE: process.execPath, ACP_FIXTURE_ARGS: JSON.stringify([agentFile]) },
    fallback: () => { fallbackStarted = true; throw new Error('不应回退'); }
  });
  childFacade.stdout.on('data', (chunk: any) => { output += chunk.toString(); });
  const [code] = await new Promise<any[]>(resolve => childFacade.on('close', (...args: any[]) => resolve(args)));
  assert.equal(code, 0); assert.equal(childFacade.protocol, 'acp'); assert.equal(fallbackStarted, false); assert.equal(output, 'ACP 完成:no');
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

  let started: any;
  const startFallback = new AcpPreferredRunner({
    primary: { start: async () => { throw Object.assign(new Error('handshake failed'), { code: 'ACP_UNAVAILABLE' }); }, close() {} },
    fallback: { start: async (job: any) => { started = job; return job; }, close() {} }
  });
  await startFallback.start({ id: 'job', protocol: 'acp', projectId: 'acp:codex', agent: 'codex' });
  assert.equal(started.protocol, 'legacy'); assert.equal(started.projectId, undefined);
});

test('Codex ACP task sessions are named and opened in the desktop client', async () => {
  const nativeId = '12345678-1234-1234-1234-123456789abc';
  class FakeConnection extends EventEmitter {
    promptStarted = false; closed = false; configured: any;
    async initialize() { return { protocolVersion: 1 }; }
    async newSession() { return { sessionId: nativeId }; }
    async configure(_session: any, model: any, effort: any) { this.configured = [model, effort]; return []; }
    async prompt() { this.promptStarted = true; return { stopReason: 'end_turn' }; }
    close() { this.closed = true; }
  }
  const named: any[] = [], opened: any[] = [], updates: any[] = [], fake = new FakeConnection();
  const runner = new AcpTaskRunner({
    agent: 'codex', environment: {}, connectionFactory: () => fake, onUpdate: (job: any) => updates.push(job),
    threadNamer: async (...args: any[]) => named.push(args), desktopOpener: async (...args: any[]) => opened.push(args)
  });
  await runner.start({ id: 'job', agent: 'codex', agentLabel: 'Codex', title: '桌面任务', cwd: process.cwd(), prompt: '执行', model: 'm2', reasoningEffort: 'high', status: 'queued' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(named, [[nativeId, '桌面任务']]); assert.deepEqual(opened, [[nativeId]]);
  assert.deepEqual(fake.configured, ['m2', 'high']);
  assert.equal(updates.some(job => job.desktopOpened === true), true);
});
