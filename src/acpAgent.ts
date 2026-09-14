import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { httpError } from './rbac.js';

type Launch = { command: string; args: string[] };

const executableNames: Record<string, string> = {
  codex: 'codex-acp',
  claude: 'claude-agent-acp'
};

function envName(agent: string, suffix: string) {
  return `ACP_${agent.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_${suffix}`;
}

function parseArgs(value: unknown) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed) || parsed.some(v => typeof v !== 'string')) throw new Error();
    return parsed;
  } catch {
    throw new Error('ACP Agent 参数必须是 JSON 字符串数组');
  }
}

/** Resolve an ACP stdio server without involving a shell. Every registered Agent
 * gets the same ACP-first policy; unknown Agents opt in with ACP_<AGENT>_EXECUTABLE. */
export function resolveAcpLaunch(agent: string, environment: any = process.env): Launch | null {
  if (environment.ACP_ENABLED === 'false' || environment[envName(agent, 'ENABLED')] === 'false') return null;
  const command = String(environment[envName(agent, 'EXECUTABLE')] || executableNames[agent] || '').trim();
  if (!command) return null;
  return { command, args: parseArgs(environment[envName(agent, 'ARGS')]) };
}

function childEnvironment(agent: string, environment: any) {
  const result = { ...environment };
  // The official Codex adapter otherwise starts conservatively in read-only mode.
  if (agent === 'codex' && !result.INITIAL_AGENT_MODE) result.INITIAL_AGENT_MODE = 'agent';
  return result;
}

function textFromUpdate(update: any) {
  return update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text'
    ? String(update.content.text || '') : '';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

export class AcpAgentConnection extends EventEmitter {
  agent: string; launch: Launch; environment: any; child: any; connection: any; context: any;
  sessionId: string | null = null; closed = false; promptStarted = false; pendingPermission: any = null; processFailure: any = null;

  constructor({ agent, launch, environment = process.env, spawnProcess = spawn }: any) {
    super();
    this.agent = agent; this.launch = launch; this.environment = environment;
    this.child = spawnProcess(launch.command, launch.args, {
      env: childEnvironment(agent, environment), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    this.child.stderr?.on('data', (chunk: any) => this.emit('diagnostic', chunk.toString()));
    this.child.on('error', (error: any) => { this.processFailure = error; this.emit('processFailure', error); });
    this.child.on('exit', (code: any, signal: any) => {
      if (!this.closed) {
        const error = Object.assign(new Error('ACP Agent 连接已关闭'), { code, signal });
        this.processFailure = error; this.emit('processFailure', error); this.emit('disconnected', error);
      }
    });
  }

  processFailurePromise() {
    if (this.processFailure) return Promise.reject(this.processFailure);
    return new Promise((_, reject) => this.once('processFailure', reject));
  }

  async initialize(timeoutMs = 10000) {
    const stream = acp.ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>
    );
    const app = acp.client({ name: 'bugflow-workbench' })
      .onNotification(acp.methods.client.session.update, (ctx: any) => {
        this.emit('update', ctx.params);
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx: any): Promise<acp.RequestPermissionResponse> => this.permission(ctx.params));
    this.connection = app.connect(stream);
    this.context = this.connection.agent;
    const request = this.context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'bugflow-workbench', title: 'Agent 任务工作台', version: '0.4.0' }
    });
    const result: any = await withTimeout(Promise.race([request, this.processFailurePromise()]), timeoutMs, 'ACP initialize 响应超时');
    if (result.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`ACP 协议版本不兼容：${result.protocolVersion}`);
    return result;
  }

  async newSession(cwd: string, timeoutMs = 15000) {
    const result: any = await withTimeout(this.context.request(acp.methods.agent.session.new, {
      cwd: await realpath(cwd), mcpServers: []
    }), timeoutMs, 'ACP session/new 响应超时');
    this.sessionId = result.sessionId;
    return result;
  }

  prompt(text: string) {
    if (!this.sessionId) throw new Error('ACP 会话尚未创建');
    this.promptStarted = true;
    return this.context.request(acp.methods.agent.session.prompt, {
      sessionId: this.sessionId, prompt: [{ type: 'text', text }]
    });
  }

  permission(params: any): Promise<acp.RequestPermissionResponse> {
    if (this.pendingPermission) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    return new Promise<acp.RequestPermissionResponse>(resolve => {
      this.pendingPermission = { params, resolve };
      this.emit('permission', params);
    });
  }

  respond(decision: string) {
    if (!this.pendingPermission) throw new Error('ACP 当前没有待处理的授权请求');
    const { params, resolve } = this.pendingPermission;
    const allowed = decision === 'accept' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
    const option = params.options.find((item: any) => allowed.includes(item.kind));
    this.pendingPermission = null;
    resolve(option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } });
  }

  async cancel() {
    if (this.pendingPermission) {
      const pending = this.pendingPermission; this.pendingPermission = null;
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    if (this.sessionId) await this.context.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.connection?.close();
    this.child?.kill('SIGTERM');
  }
}

export async function probeAcpAgent(agent: string, environment: any = process.env, connectionFactory?: any) {
  const launch = resolveAcpLaunch(agent, environment);
  if (!launch) return false;
  const connection = connectionFactory ? connectionFactory({ agent, launch, environment }) : new AcpAgentConnection({ agent, launch, environment });
  try { await connection.initialize(5000); return true; }
  catch { return false; }
  finally { connection.close(); }
}

/** ChildProcess-shaped one-shot bridge used by the existing workflow engine. */
export function spawnAcpPreferredAgent({ agent, cwd, prompt, environment = process.env, fallback }: any) {
  const facade: any = new EventEmitter();
  facade.stdout = new PassThrough(); facade.stderr = new PassThrough(); facade.pid = undefined;
  facade.protocol = 'probing'; facade.connection = null; facade.child = null; facade.stopped = false;
  facade.kill = (signal = 'SIGTERM') => {
    facade.stopped = true;
    if (facade.connection) { void facade.connection.cancel().finally(() => facade.connection.close()); return true; }
    return facade.child?.kill(signal) ?? false;
  };
  queueMicrotask(async () => {
    const launch = resolveAcpLaunch(agent, environment);
    if (launch) {
      const connection = new AcpAgentConnection({ agent, launch, environment });
      facade.connection = connection; facade.pid = connection.child.pid;
      connection.on('diagnostic', (value: string) => facade.stderr.write(value));
      connection.on('update', ({ update }: any) => { const value = textFromUpdate(update); if (value) facade.stdout.write(value); });
      connection.on('permission', () => connection.respond('decline'));
      try {
        await connection.initialize(); await connection.newSession(cwd);
        facade.protocol = 'acp'; facade.emit('protocol', 'acp');
        const result: any = await connection.prompt(prompt);
        connection.close(); facade.stdout.end(); facade.stderr.end();
        facade.emit('close', result.stopReason === 'end_turn' ? 0 : 1, result.stopReason === 'cancelled' ? 'SIGTERM' : null);
        return;
      } catch (error: any) {
        const mayFallback = !connection.promptStarted;
        connection.close(); facade.connection = null;
        if (facade.stopped) { facade.stdout.end(); facade.stderr.end(); facade.emit('close', null, 'SIGTERM'); return; }
        if (!mayFallback) { facade.stderr.write(error.message); facade.emit('close', 1, null); return; }
        facade.stderr.write(`[acp] ${error.message}；回退到原执行通道。\n`);
      }
    }
    if (facade.stopped) { facade.stdout.end(); facade.stderr.end(); facade.emit('close', null, 'SIGTERM'); return; }
    try {
      facade.protocol = 'legacy'; facade.emit('protocol', 'legacy');
      const child = fallback(); facade.child = child; facade.pid = child.pid;
      child.stdout?.on('data', (chunk: any) => facade.stdout.write(chunk));
      child.stderr?.on('data', (chunk: any) => facade.stderr.write(chunk));
      child.on('error', (error: any) => facade.emit('error', error));
      child.on('close', (code: any, signal: any) => { facade.stdout.end(); facade.stderr.end(); facade.emit('close', code, signal); });
    } catch (error: any) { facade.emit('error', error); }
  });
  return facade;
}

export function acpProject(root: string, agent = 'codex') {
  return { id: `acp:${agent}`, name: `${agent === 'codex' ? 'Codex' : agent} · ACP`, cwd: path.resolve(root), protocol: 'acp', agent };
}

const activeStatuses = new Set(['launching', 'running', 'waiting']);
const now = () => new Date().toISOString();

/** ACP implementation of the task-center runner. One process is kept for each
 * active session so permissions and cancellation remain bidirectional. */
export class AcpTaskRunner {
  agent: string; environment: any; onUpdate: any; connectionFactory: any; jobs = new Map(); connections = new Map(); available: any = undefined;
  constructor({ agent = 'codex', environment = process.env, onUpdate = () => {}, connectionFactory }: any = {}) {
    this.agent = agent; this.environment = environment; this.onUpdate = onUpdate; this.connectionFactory = connectionFactory;
  }
  publish(job: any, patch: any) { Object.assign(job, patch, { updatedAt: now() }); this.onUpdate(structuredClone(job)); }
  async projects(root: string) {
    if (this.available === undefined) this.available = await probeAcpAgent(this.agent, this.environment, this.connectionFactory);
    if (!this.available) throw Object.assign(new Error(`${this.agent} 未提供可用的 ACP 服务`), { code: 'ACP_UNAVAILABLE' });
    const cwd = await realpath(root);
    return [acpProject(cwd, this.agent)];
  }
  async start(input: any) {
    if (this.jobs.has(input.id)) return this.jobs.get(input.id);
    const job = { ...input, agent: input.agent || this.agent, protocol: 'acp' };
    this.jobs.set(job.id, job);
    const launch = resolveAcpLaunch(job.agent, this.environment);
    if (!launch) throw new Error('ACP Agent 未配置');
    const connection = this.connectionFactory
      ? this.connectionFactory({ agent: job.agent, launch, environment: this.environment })
      : new AcpAgentConnection({ agent: job.agent, launch, environment: this.environment });
    this.connections.set(job.id, connection);
    connection.on('update', ({ update }: any) => {
      const value = textFromUpdate(update);
      if (value) this.publish(job, { output: `${job.output || ''}${value}`.slice(-24000) });
    });
    connection.on('permission', (params: any) => this.publish(job, {
      status: 'waiting', request: { method: 'session/request_permission', params }, message: `${job.agentLabel || job.agent} 等待操作确认`
    }));
    connection.on('disconnected', () => {
      if (activeStatuses.has(job.status)) this.publish(job, { status: 'unknown', request: null, message: 'ACP 连接中断；不会自动重复执行。' });
    });
    try {
      this.publish(job, { status: 'launching', message: `正在通过 ACP 创建 ${job.agentLabel || job.agent} 会话` });
      await connection.initialize();
      const session = await connection.newSession(job.cwd);
      this.publish(job, { sessionId: session.sessionId, status: 'running', message: `${job.agentLabel || job.agent} 正在通过 ACP 执行` });
      void connection.prompt(job.prompt).then((result: any) => {
        const status = result.stopReason === 'end_turn' ? 'completed' : result.stopReason === 'cancelled' ? 'interrupted' : 'failed';
        this.publish(job, { status, request: null, message: status === 'completed' ? 'ACP 本轮执行完成' : `ACP 执行结束：${result.stopReason}` });
        this.connections.delete(job.id); connection.close();
      }).catch((error: any) => {
        this.publish(job, { status: 'failed', request: null, message: error.message });
        this.connections.delete(job.id); connection.close();
      });
    } catch (error: any) {
      this.connections.delete(job.id); connection.close(); this.available = false;
      if (!connection.promptStarted) {
        this.jobs.delete(job.id);
        throw Object.assign(error, { code: 'ACP_UNAVAILABLE' });
      }
      this.publish(job, { status: 'unknown', request: null, message: error.message });
    }
    return job;
  }
  async respond(id: string, input: any) {
    const job = this.jobs.get(id), connection = this.connections.get(id);
    if (!job || !connection) throw httpError(409, 'ACP 请求已失效，请刷新执行状态');
    if (!['accept', 'decline'].includes(input.decision)) throw httpError(400, '确认结果无效');
    connection.respond(input.decision);
    this.publish(job, { status: 'running', request: null, message: '已回复 Agent，继续通过 ACP 执行' });
  }
  async stop(id: string) {
    const connection = this.connections.get(id);
    if (!connection) throw httpError(409, 'ACP 会话当前未连接');
    await connection.cancel();
  }
  async reconcile() {
    throw httpError(409, 'ACP v1 不提供通用的已结束执行查询；请在 Agent 中核对会话');
  }
  close() { for (const connection of this.connections.values()) connection.close(); this.connections.clear(); }
}

export class AcpPreferredRunner {
  primary: any; fallback: any; routes = new Map();
  constructor({ primary, fallback }: any) { this.primary = primary; this.fallback = fallback; }
  async projects(root: string) {
    try { return await this.primary.projects(root); }
    catch (error: any) { if (error.code !== 'ACP_UNAVAILABLE') throw error; return this.fallback.projects(root); }
  }
  route(jobOrId: any) {
    const protocol = typeof jobOrId === 'object' ? jobOrId.protocol : this.routes.get(jobOrId);
    return protocol === 'acp' ? this.primary : this.fallback;
  }
  async start(job: any) {
    this.routes.set(job.id, job.protocol);
    try { return await this.route(job).start(job); }
    catch (error: any) {
      if (job.protocol !== 'acp' || error.code !== 'ACP_UNAVAILABLE') throw error;
      const legacyJob = { ...job, protocol: 'legacy', projectId: undefined, message: `ACP 不可用，回退 ${job.agentLabel || job.agent || 'Agent'} 原执行通道` };
      this.routes.set(job.id, 'legacy');
      return this.fallback.start(legacyJob);
    }
  }
  async respond(id: string, input: any) { return this.route(id).respond(id, input); }
  async stop(id: string) { return this.route(id).stop(id); }
  async reconcile(job: any) { return this.route(job).reconcile(job); }
  close() { this.primary.close(); this.fallback.close(); }
}
