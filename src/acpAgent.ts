import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
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

export function configuredAcpAgents(environment: any = process.env) {
  const configured = String(environment.ACP_AGENTS || '').split(',').map(value => value.trim()).filter(Boolean);
  return [...new Set(['codex', 'claude', ...configured])];
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

function flatOptions(option: any) {
  return (option?.options || []).flatMap((item: any) => Array.isArray(item.options) ? item.options : [item]);
}

function configurationCatalog(configOptions: any[] = []) {
  const model = configOptions.find((option: any) => option.type === 'select' && (option.category === 'model' || option.id === 'model'));
  const effort = configOptions.find((option: any) => option.type === 'select' && (option.category === 'thought_level' || ['reasoning_effort', 'effort'].includes(option.id)));
  return {
    models: flatOptions(model).map((item: any) => ({ id: item.value, name: item.name, description: item.description || '' })),
    defaultModel: model?.currentValue || '',
    reasoningEfforts: flatOptions(effort).map((item: any) => ({ id: item.value, name: item.name, description: item.description || '' })),
    defaultReasoningEffort: effort?.currentValue || ''
  };
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
      clientCapabilities: { session: { configOptions: {} } },
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

  async configure(session: any, modelId?: string, reasoningEffort?: string) {
    let options = session.configOptions || [];
    const apply = async (category: string, aliases: string[], value?: string) => {
      if (!value) return;
      const option = options.find((item: any) => item.type === 'select' && (item.category === category || aliases.includes(item.id)));
      if (!option) throw new Error(`当前 Agent 不支持${category === 'model' ? '模型' : '思考强度'}选择`);
      if (!flatOptions(option).some((item: any) => item.value === value)) throw new Error(`${option.name} 不支持选项：${value}`);
      const response: any = await this.context.request(acp.methods.agent.session.setConfigOption, { sessionId: this.sessionId, configId: option.id, value });
      options = response.configOptions || options;
    };
    await apply('model', ['model'], modelId);
    await apply('thought_level', ['reasoning_effort', 'effort'], reasoningEffort);
    return options;
  }

  async catalog(session: any) {
    const base = configurationCatalog(session.configOptions || []), models = [];
    const modelOption = (session.configOptions || []).find((item: any) => item.type === 'select' && (item.category === 'model' || item.id === 'model'));
    for (const model of base.models) {
      let options = session.configOptions || [];
      try {
        const response: any = await this.context.request(acp.methods.agent.session.setConfigOption, { sessionId: this.sessionId, configId: modelOption.id, value: model.id });
        options = response.configOptions || options;
      } catch { /* Keep the model visible even if live capability discovery fails. */ }
      const effort = configurationCatalog(options);
      models.push({ ...model, reasoningEfforts: effort.reasoningEfforts, defaultReasoningEffort: effort.defaultReasoningEffort });
    }
    return { ...base, models };
  }

  async closeSession() {
    if (this.sessionId) await this.context.request(acp.methods.agent.session.close, { sessionId: this.sessionId });
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

export function acpProject(root: string, agent = 'codex', configuration: any = {}) {
  const labels: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' };
  return { id: `acp:${agent}`, name: labels[agent] || agent, cwd: path.resolve(root), protocol: 'acp', agent, ...configuration };
}

const activeStatuses = new Set(['launching', 'running', 'waiting']);
const now = () => new Date().toISOString();

/** ACP implementation of the task-center runner. One process is kept for each
 * active session so permissions and cancellation remain bidirectional. */
export class AcpTaskRunner {
  agent: string; environment: any; onUpdate: any; connectionFactory: any; desktopOpener: any; threadNamer: any; jobs = new Map(); connections = new Map(); available: any = undefined; configuration: any = undefined;
  constructor({ agent = 'codex', environment = process.env, onUpdate = () => {}, connectionFactory, desktopOpener = async () => {}, threadNamer = async () => {} }: any = {}) {
    this.agent = agent; this.environment = environment; this.onUpdate = onUpdate; this.connectionFactory = connectionFactory; this.desktopOpener = desktopOpener; this.threadNamer = threadNamer;
  }
  publish(job: any, patch: any) { Object.assign(job, patch, { updatedAt: now() }); this.onUpdate(structuredClone(job)); }
  async projects(root: string) {
    const cwd = await realpath(root);
    if (this.available === undefined) {
      const launch = resolveAcpLaunch(this.agent, this.environment);
      if (!launch) this.available = false;
      else {
        const connection = this.connectionFactory ? this.connectionFactory({ agent: this.agent, launch, environment: this.environment }) : new AcpAgentConnection({ agent: this.agent, launch, environment: this.environment });
        try {
          await connection.initialize(5000);
          const session = await connection.newSession(cwd);
          this.configuration = await connection.catalog(session);
          try { await connection.closeSession(); } catch { /* Empty discovery sessions may not have a persisted transcript. */ }
          this.available = true;
        } catch { this.available = false; }
        finally { connection.close(); }
      }
    }
    if (!this.available) throw Object.assign(new Error(`${this.agent} 未提供可用的 ACP 服务`), { code: 'ACP_UNAVAILABLE' });
    return [acpProject(cwd, this.agent, this.configuration)];
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
      await connection.configure(session, job.model, job.reasoningEffort);
      this.publish(job, { sessionId: session.sessionId, status: 'running', message: `${job.agentLabel || job.agent} 正在通过 ACP 执行` });
      if (job.agent === 'codex' && /^[a-f0-9-]{36}$/.test(session.sessionId)) {
        try { await this.threadNamer(session.sessionId, job.title); } catch { /* The session still works without a custom title. */ }
        try { await this.desktopOpener(session.sessionId); this.publish(job, { desktopOpened: true }); }
        catch { this.publish(job, { desktopOpened: false, desktopMessage: 'Codex 会话已创建，但无法自动在客户端打开。' }); }
      }
      void connection.prompt(job.prompt).then((result: any) => {
        const status = result.stopReason === 'end_turn' ? 'completed' : result.stopReason === 'cancelled' ? 'interrupted' : 'failed';
        this.publish(job, { status, request: null, message: status === 'completed' ? 'ACP 本轮执行完成' : `ACP 执行结束：${result.stopReason}` });
        this.connections.delete(job.id); connection.close();
      }).catch((error: any) => {
        this.publish(job, { status: 'failed', request: null, message: error.message });
        this.connections.delete(job.id); connection.close();
      });
    } catch (error: any) {
      this.connections.delete(job.id); connection.close();
      if (connection.sessionId) {
        this.publish(job, { status: 'failed', request: null, message: error.message });
        return job;
      }
      this.available = false;
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

/** Routes task-center jobs across every locally available Agent while keeping
 * one runner (and therefore one permission/cancellation channel) per Agent. */
export class AgentRunnerSet {
  runners: Map<string, any>; routes = new Map<string, string>();
  constructor(entries: Iterable<[string, any]>) { this.runners = new Map(entries); }
  async projects(root: string) {
    const results = await Promise.allSettled([...this.runners.values()].map(runner => runner.projects(root)));
    const projects = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    if (projects.length) return projects;
    const failure: any = results.find(result => result.status === 'rejected');
    throw failure?.reason || new Error('未发现可用的 Agent 执行目标');
  }
  runner(agent: string) {
    const runner = this.runners.get(agent);
    if (!runner) throw httpError(400, `Agent ${agent} 不可用`);
    return runner;
  }
  async start(job: any) { this.routes.set(job.id, job.agent); return this.runner(job.agent).start(job); }
  async respond(id: string, input: any) { return this.runner(this.routes.get(id) || 'codex').respond(id, input); }
  async stop(id: string) { return this.runner(this.routes.get(id) || 'codex').stop(id); }
  async reconcile(job: any) { return this.runner(job.agent || this.routes.get(job.id) || 'codex').reconcile(job); }
  close() { for (const runner of this.runners.values()) runner.close(); }
}
