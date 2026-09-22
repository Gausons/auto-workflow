import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { httpError } from './rbac.js';
import type { AgentProject, Execution, ExecutionStatus } from '../public/taskTypes.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Environment } from './issueSources/types.js';

type Launch = { command: string; args: string[] };
type ErrorLike = Error & { code?: string };
interface RunnerJob {
  id: string; status?: string; agent?: string; agentLabel?: string; protocol?: string; projectId?: string;
  title?: string; cwd?: string; prompt?: string; resumeSessionId?: string; sessionId?: string | null;
  model?: string | null; reasoningEffort?: string | null; conversationId?: string; output?: string;
  contextEvents?: unknown[]; request?: unknown; desktopOpened?: boolean; desktopMessage?: string; updatedAt?: string;
  [key: string]: unknown;
}
type RunnerProject = Partial<AgentProject> & { id: string };
type SelectOption = Extract<acp.SessionConfigOption, { type: 'select' }>;
type Catalog = { models: Array<{ id: string; name: string; description: string; reasoningEfforts?: Catalog['reasoningEfforts']; defaultReasoningEffort?: string }>; defaultModel: string; reasoningEfforts: Array<{ id: string; name: string; description: string }>; defaultReasoningEffort: string };
interface PendingPermission { params: acp.RequestPermissionRequest; resolve: (value: acp.RequestPermissionResponse) => void }
interface RunnerInput { decision?: string }
interface RunnerLike {
  projects?(root: string): Promise<RunnerProject[]>;
  start?(job: RunnerJob): Promise<unknown> | unknown;
  respond?(id: string, input: RunnerInput): Promise<unknown>;
  stop?(id: string): Promise<unknown>;
  reconcile?(job: RunnerJob): Promise<unknown>;
  close(): void;
}
interface ConnectionLike extends EventEmitter {
  closed: boolean; promptStarted: boolean; sessionId?: string | null;
  initialize(timeoutMs?: number): Promise<unknown>;
  newSession(cwd: string): Promise<acp.NewSessionResponse>;
  loadSession(sessionId: string, cwd: string): Promise<acp.NewSessionResponse>;
  configure(session: acp.NewSessionResponse, modelId?: string | null, reasoningEffort?: string | null): Promise<acp.SessionConfigOption[]>;
  catalog(session: acp.NewSessionResponse): Promise<Catalog>;
  closeSession(): Promise<void>;
  prompt(text: string): Promise<acp.PromptResponse>;
  respond(decision: string): void;
  cancel(): Promise<void>;
  close(): void;
}

const asError = (error: unknown): ErrorLike => error instanceof Error ? error as ErrorLike : new Error(String(error));

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
export function resolveAcpLaunch(agent: string, environment: Environment = process.env): Launch | null {
  if (environment.ACP_ENABLED === 'false' || environment[envName(agent, 'ENABLED')] === 'false') return null;
  const command = String(environment[envName(agent, 'EXECUTABLE')] || executableNames[agent] || '').trim();
  if (!command) return null;
  return { command, args: parseArgs(environment[envName(agent, 'ARGS')]) };
}

export function configuredAcpAgents(environment: Environment = process.env) {
  const configured = String(environment.ACP_AGENTS || '').split(',').map(value => value.trim()).filter(Boolean);
  return [...new Set(['codex', 'claude', ...configured])];
}

function childEnvironment(agent: string, environment: Environment): Environment {
  const result = { ...environment };
  // The official Codex adapter otherwise starts conservatively in read-only mode.
  if (agent === 'codex' && !result.INITIAL_AGENT_MODE) result.INITIAL_AGENT_MODE = 'agent';
  return result;
}

function textFromUpdate(update: acp.SessionUpdate) {
  return update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text'
    ? String(update.content.text || '') : '';
}

function isSelectOption(option: acp.SessionConfigOption | undefined): option is SelectOption { return option?.type === 'select'; }

function flatOptions(option: acp.SessionConfigOption | undefined): acp.SessionConfigSelectOption[] {
  if (!isSelectOption(option)) return [];
  return (option.options || []).flatMap((item) => 'options' in item && Array.isArray(item.options) ? item.options : [item as acp.SessionConfigSelectOption]);
}

function configurationCatalog(configOptions: acp.SessionConfigOption[] = []): Catalog {
  const model = configOptions.find((option) => option.type === 'select' && (option.category === 'model' || option.id === 'model'));
  const effort = configOptions.find((option) => option.type === 'select' && (option.category === 'thought_level' || ['reasoning_effort', 'effort'].includes(option.id)));
  return {
    models: flatOptions(model).map((item) => ({ id: item.value, name: item.name, description: item.description || '' })),
    defaultModel: isSelectOption(model) ? model.currentValue : '',
    reasoningEfforts: flatOptions(effort).map((item) => ({ id: item.value, name: item.name, description: item.description || '' })),
    defaultReasoningEffort: isSelectOption(effort) ? effort.currentValue : ''
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
  agent: string; launch: Launch; environment: Environment; child: ChildProcessWithoutNullStreams;
  connection?: acp.ClientConnection; context?: acp.ClientContext;
  capabilities: acp.AgentCapabilities = {};
  sessionId: string | null = null; closed = false; promptStarted = false;
  pendingPermission: PendingPermission | null = null; processFailure: Error | null = null;

  constructor({ agent, launch, environment = process.env, spawnProcess = spawn }: { agent: string; launch: Launch; environment?: Environment; spawnProcess?: typeof spawn }) {
    super();
    this.agent = agent; this.launch = launch; this.environment = environment;
    this.child = spawnProcess(launch.command, launch.args, {
      env: childEnvironment(agent, environment), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    }) as ChildProcessWithoutNullStreams;
    this.child.stderr.on('data', (chunk: Buffer) => this.emit('diagnostic', chunk.toString()));
    this.child.on('error', (error) => { this.processFailure = error; this.emit('processFailure', error); });
    this.child.on('exit', (code, signal) => {
      if (!this.closed) {
        const error = Object.assign(new Error('ACP Agent 连接已关闭'), { code, signal });
        this.closed = true; this.processFailure = error; this.emit('processFailure', error); this.emit('disconnected', error);
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
      .onNotification(acp.methods.client.session.update, (ctx) => {
        this.emit('update', ctx.params);
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx): Promise<acp.RequestPermissionResponse> => this.permission(ctx.params));
    this.connection = app.connect(stream);
    this.context = this.connection.agent;
    const request = this.context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { session: { configOptions: {} } },
      clientInfo: { name: 'bugflow-workbench', title: 'Agent 任务工作台', version: '0.4.0' }
    });
    const result = await withTimeout(Promise.race([request, this.processFailurePromise()]), timeoutMs, 'ACP initialize 响应超时') as acp.InitializeResponse;
    if (result.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`ACP 协议版本不兼容：${result.protocolVersion}`);
    this.capabilities = result.agentCapabilities || {};
    return result;
  }

  async loadSession(sessionId: string, cwd: string) {
    if (!this.capabilities.loadSession) throw httpError(409, "当前 Agent 不支持恢复已关闭的会话，请用其他 Agent 新开会话继续");
    const result = await this.context!.request(acp.methods.agent.session.load, { sessionId, cwd: await realpath(cwd), mcpServers: [] });
    this.sessionId = sessionId;
    return { ...result, sessionId };
  }

  async newSession(cwd: string, timeoutMs = 15000) {
    const result = await withTimeout(this.context!.request(acp.methods.agent.session.new, {
      cwd: await realpath(cwd), mcpServers: []
    }), timeoutMs, 'ACP session/new 响应超时') as acp.NewSessionResponse;
    this.sessionId = result.sessionId;
    return result;
  }

  async configure(session: acp.NewSessionResponse, modelId?: string | null, reasoningEffort?: string | null) {
    let options = session.configOptions || [];
    const apply = async (category: string, aliases: string[], value?: string) => {
      if (!value) return;
      const option = options.find((item) => item.type === 'select' && (item.category === category || aliases.includes(item.id)));
      if (!option) throw new Error(`当前 Agent 不支持${category === 'model' ? '模型' : '思考强度'}选择`);
      if (!flatOptions(option).some((item) => item.value === value)) throw new Error(`${option.name} 不支持选项：${value}`);
      const response = await this.context!.request(acp.methods.agent.session.setConfigOption, { sessionId: this.sessionId!, configId: option.id, value });
      options = response.configOptions || options;
    };
    await apply('model', ['model'], modelId || undefined);
    await apply('thought_level', ['reasoning_effort', 'effort'], reasoningEffort || undefined);
    return options;
  }

  async catalog(session: acp.NewSessionResponse): Promise<Catalog> {
    const base = configurationCatalog(session.configOptions || []), models: Catalog['models'] = [];
    const modelOption = (session.configOptions || []).find((item) => item.type === 'select' && (item.category === 'model' || item.id === 'model'));
    for (const model of base.models) {
      let options = session.configOptions || [];
      try {
        if (!modelOption) throw new Error('当前 Agent 未返回模型配置项');
        const response = await this.context!.request(acp.methods.agent.session.setConfigOption, { sessionId: this.sessionId!, configId: modelOption.id, value: model.id });
        options = response.configOptions || options;
      } catch { /* Keep the model visible even if live capability discovery fails. */ }
      const effort = configurationCatalog(options);
      models.push({ ...model, reasoningEfforts: effort.reasoningEfforts, defaultReasoningEffort: effort.defaultReasoningEffort });
    }
    return { ...base, models };
  }

  async closeSession() {
    if (this.sessionId) await this.context!.request(acp.methods.agent.session.close, { sessionId: this.sessionId });
  }

  prompt(text: string) {
    if (!this.sessionId) throw new Error('ACP 会话尚未创建');
    this.promptStarted = true;
    return this.context!.request(acp.methods.agent.session.prompt, {
      sessionId: this.sessionId, prompt: [{ type: 'text', text }]
    });
  }

  permission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
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
    const option = params.options.find((item) => allowed.includes(item.kind));
    this.pendingPermission = null;
    resolve(option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } });
  }

  async cancel() {
    if (this.pendingPermission) {
      const pending = this.pendingPermission; this.pendingPermission = null;
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    if (this.sessionId) await this.context!.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.connection?.close();
    this.child?.kill('SIGTERM');
  }
}

export async function probeAcpAgent(agent: string, environment: Environment = process.env, connectionFactory?: (options: { agent: string; launch: Launch; environment: Environment }) => unknown) {
  const launch = resolveAcpLaunch(agent, environment);
  if (!launch) return false;
  const connection = (connectionFactory ? connectionFactory({ agent, launch, environment }) : new AcpAgentConnection({ agent, launch, environment })) as ConnectionLike;
  try { await connection.initialize(5000); return true; }
  catch { return false; }
  finally { connection.close(); }
}

export function acpProject(root: string, agent = 'codex', configuration: Partial<AgentProject> = {}): AgentProject {
  const labels: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' };
  return { id: `acp:${agent}`, name: labels[agent] || agent, cwd: path.resolve(root), protocol: 'acp', agent, ...configuration };
}

const activeStatuses = new Set(['launching', 'running', 'waiting']);
const now = () => new Date().toISOString();

/** ACP implementation of the task-center runner. One process is kept for each
 * active session so permissions and cancellation remain bidirectional. */
export class AcpTaskRunner {
  retained = new Map<string, ConnectionLike>();
  agent: string; environment: Environment; onUpdate: (job: Execution) => void;
  connectionFactory?: (options: { agent: string; launch: Launch; environment: Environment }) => unknown;
  desktopOpener: (sessionId: string) => Promise<unknown>; threadNamer: (sessionId: string, name: string) => Promise<unknown>;
  jobs: { get(key: string): RunnerJob } & Map<string, RunnerJob> = new Map<string, RunnerJob>() as { get(key: string): RunnerJob } & Map<string, RunnerJob>;
  connections = new Map<string, ConnectionLike>(); available: boolean | undefined = undefined; configuration: Catalog | undefined = undefined;
  constructor({ agent = 'codex', environment = process.env, onUpdate = () => {}, connectionFactory, desktopOpener = async () => {}, threadNamer = async () => {} }: {
    agent?: string; environment?: Environment; onUpdate?: (job: Execution) => void;
    connectionFactory?: (options: { agent: string; launch: Launch; environment: Environment }) => unknown;
    desktopOpener?: (sessionId: string) => Promise<unknown>; threadNamer?: (sessionId: string, name: string) => Promise<unknown>;
  } = {}) {
    this.agent = agent; this.environment = environment; this.onUpdate = onUpdate; this.connectionFactory = connectionFactory; this.desktopOpener = desktopOpener; this.threadNamer = threadNamer;
  }
  publish(job: RunnerJob, patch: Partial<RunnerJob> & Record<string, unknown>) { Object.assign(job, patch, { updatedAt: now() }); this.onUpdate(structuredClone(job) as unknown as Execution); }
  async projects(root: string) {
    const cwd = await realpath(root);
    if (this.available === undefined) {
      const launch = resolveAcpLaunch(this.agent, this.environment);
      if (!launch) this.available = false;
      else {
        const connection = (this.connectionFactory ? this.connectionFactory({ agent: this.agent, launch, environment: this.environment }) : new AcpAgentConnection({ agent: this.agent, launch, environment: this.environment })) as ConnectionLike;
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
  async start(input: RunnerJob) {
    if (this.jobs.has(input.id)) return this.jobs.get(input.id);
    const job: RunnerJob = { ...input, agent: input.agent || this.agent, protocol: 'acp' };
    this.jobs.set(job.id, job);
    const agent = job.agent || this.agent;
    const launch = resolveAcpLaunch(agent, this.environment);
    if (!launch) throw new Error('ACP Agent 未配置');
    const retained = job.resumeSessionId ? this.retained.get(job.resumeSessionId) : null;
    const connection = (retained && !retained.closed ? retained : this.connectionFactory
      ? this.connectionFactory({ agent: job.agent!, launch, environment: this.environment })
      : new AcpAgentConnection({ agent: job.agent!, launch, environment: this.environment })) as ConnectionLike;
    this.connections.set(job.id, connection);
    connection.removeAllListeners("update"); connection.removeAllListeners("permission"); connection.removeAllListeners("disconnected");
    let acceptingUpdates = false, creatingSession = false, promptDispatched = false;
    connection.on('update', ({ update }: acp.SessionNotification) => {
      if (!acceptingUpdates) return;
      const value = textFromUpdate(update);
      if (value) this.publish(job, { output: job.conversationId ? `${job.output || ''}${value}` : `${job.output || ''}${value}`.slice(-24000) });
      if (job.conversationId && ['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) this.publish(job, { contextEvents: [...(job.contextEvents || []), update] });
    });
    connection.on('permission', (params: acp.RequestPermissionRequest) => this.publish(job, {
      status: 'waiting', request: { method: 'session/request_permission', params }, message: `${job.agentLabel || job.agent} 等待操作确认`
    }));
    connection.on('disconnected', () => {
      if (activeStatuses.has(job.status || '')) this.publish(job, { status: 'unknown', request: null, message: 'ACP 连接中断；不会自动重复执行。' });
    });
    try {
      this.publish(job, { status: 'launching', message: `正在通过 ACP 创建 ${job.agentLabel || job.agent} 会话` });
      if (connection !== retained || connection.closed) await connection.initialize();
      creatingSession = !job.resumeSessionId;
      if (!job.cwd) throw new Error('ACP 工作目录未配置');
      const session: acp.NewSessionResponse = job.resumeSessionId
        ? connection === retained && !connection.closed ? { sessionId: job.resumeSessionId } : await connection.loadSession(job.resumeSessionId, job.cwd)
        : await connection.newSession(job.cwd);
      creatingSession = false;
      await connection.configure(session, job.model, job.reasoningEffort);
      this.publish(job, { sessionId: session.sessionId, status: 'running', message: `${job.agentLabel || job.agent} 正在通过 ACP 执行` });
      if (!job.resumeSessionId && job.agent === 'codex' && /^[a-f0-9-]{36}$/.test(session.sessionId)) {
        try { await this.threadNamer(session.sessionId, job.title || '未命名任务'); } catch { /* The session still works without a custom title. */ }
        try { await this.desktopOpener(session.sessionId); this.publish(job, { desktopOpened: true }); }
        catch { this.publish(job, { desktopOpened: false, desktopMessage: 'Codex 会话已创建，但无法自动在客户端打开。' }); }
      }
      acceptingUpdates = true; promptDispatched = true;
      void connection.prompt(job.prompt!).then((result) => {
        const status = result.stopReason === 'end_turn' ? 'completed' : result.stopReason === 'cancelled' ? 'interrupted' : 'failed';
        this.publish(job, { status, request: null, message: status === 'completed' ? 'ACP 本轮执行完成' : `ACP 执行结束：${result.stopReason}` });
        this.connections.delete(job.id);
        if (job.conversationId) this.retained.set(session.sessionId, connection); else connection.close();
      }).catch((error: unknown) => {
        this.publish(job, { status: 'unknown', request: null, message: asError(error).message });
        this.retained.delete(session.sessionId); this.connections.delete(job.id); connection.close();
      });
    } catch (caught: unknown) {
      const error = asError(caught);
      this.connections.delete(job.id); connection.close();
      if (job.conversationId && (creatingSession || promptDispatched)) {
        this.publish(job, { status: 'unknown', request: null, message: error.message });
        return job;
      }
      if (job.resumeSessionId) {
        this.retained.delete(job.resumeSessionId);
        this.publish(job, { status: "failed", request: null, message: error.message });
        return job;
      }
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
  async respond(id: string, input: RunnerInput) {
    const job = this.jobs.get(id), connection = this.connections.get(id);
    if (!job || !connection) throw httpError(409, 'ACP 请求已失效，请刷新执行状态');
    if (!['accept', 'decline'].includes(input.decision || '')) throw httpError(400, '确认结果无效');
    connection.respond(input.decision!);
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
  close() { for (const connection of new Set([...this.connections.values(), ...this.retained.values()])) connection.close(); this.connections.clear(); this.retained.clear(); }
}

export class AcpPreferredRunner {
  primary: RunnerLike; fallback: RunnerLike; routes = new Map<string, string>();
  constructor({ primary, fallback }: { primary: RunnerLike; fallback: RunnerLike }) { this.primary = primary; this.fallback = fallback; }
  async projects(root: string) {
    try { return await this.primary.projects!(root); }
    catch (caught: unknown) { const error = asError(caught); if (error.code !== 'ACP_UNAVAILABLE') throw error; return this.fallback.projects!(root); }
  }
  route(jobOrId: RunnerJob | string) {
    const protocol = typeof jobOrId === 'object' ? jobOrId.protocol : this.routes.get(jobOrId);
    return protocol === 'acp' ? this.primary : this.fallback;
  }
  async start(job: RunnerJob) {
    this.routes.set(job.id, job.protocol || 'legacy');
    try { return await this.route(job).start!(job); }
    catch (caught: unknown) {
      const error = asError(caught);
      if (job.resumeSessionId || job.protocol !== 'acp' || error.code !== 'ACP_UNAVAILABLE') throw error;
      const legacyJob = { ...job, protocol: 'legacy', projectId: undefined, message: `ACP 不可用，回退 ${job.agentLabel || job.agent || 'Agent'} 原执行通道` };
      this.routes.set(job.id, 'legacy');
      return this.fallback.start!(legacyJob);
    }
  }
  async respond(id: string, input: RunnerInput) { return this.route(id).respond!(id, input); }
  async stop(id: string) { return this.route(id).stop!(id); }
  async reconcile(job: RunnerJob) { return this.route(job).reconcile!(job); }
  close() { this.primary.close(); this.fallback.close(); }
}

/** Routes task-center jobs across every locally available Agent while keeping
 * one runner (and therefore one permission/cancellation channel) per Agent. */
export class AgentRunnerSet {
  runners: Map<string, RunnerLike>; routes = new Map<string, string>();
  constructor(entries: Iterable<[string, RunnerLike]>) { this.runners = new Map(entries); }
  async projects(root: string): Promise<AgentProject[]> {
    const results = await Promise.allSettled([...this.runners.values()].map(runner => runner.projects!(root)));
    const projects = results.flatMap(result => result.status === 'fulfilled' ? result.value : []) as AgentProject[];
    if (projects.length) return projects;
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    throw failure?.reason || new Error('未发现可用的 Agent 执行目标');
  }
  runner(agent: string) {
    const runner = this.runners.get(agent);
    if (!runner) throw httpError(400, `Agent ${agent} 不可用`);
    return runner;
  }
  async start(job: RunnerJob) { const agent = job.agent || 'codex'; this.routes.set(job.id, agent); return this.runner(agent).start!(job); }
  async respond(id: string, input: RunnerInput) { return this.runner(this.routes.get(id) || 'codex').respond!(id, input); }
  async stop(id: string) { return this.runner(this.routes.get(id) || 'codex').stop!(id); }
  async reconcile(job: RunnerJob) { return this.runner(job.agent || this.routes.get(job.id) || 'codex').reconcile!(job); }
  close() { for (const runner of this.runners.values()) runner.close(); }
}
