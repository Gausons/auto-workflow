import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { taskContent } from '../public/taskContent.js';
import type { AgentProject, Execution, HistoryMessage, RemoteContextHandoff, Session, TaskCenterData } from '../public/taskTypes.js';
import { cleanContextEntries, contextPrompt, freezeContext, readContext, type ContextDelivery, type ContextEntry, type SessionContext } from './contextCompiler.js';
import type { SummaryResult } from './contextModelSummary.js';
import type { Environment } from './issueSources/types.js';
import { deliverRecord } from './sessionDelivery/records.js';
import { httpError } from './rbac.js';
import { verifyBundle, verifySnapshot } from '@auto-workflow/context-engine';

type Database = ReturnType<typeof import('./database.js').openDatabase>;
type ManagedSession = Session & {
  source: 'conversation';
  taskId: string;
  contextId: string;
  sourceSessionId: string;
};
type CatalogSession = Pick<Session, 'id' | 'agent' | 'title' | 'cwd' | 'updatedAt'> & {
  sessionId: string;
  nativeId?: string | null;
  workspaces?: string[];
  model?: string;
  branch?: string;
};
interface HistoryCatalog {
  sessions: CatalogSession[];
  providers?: Array<{ id: string; label?: string; status?: string; skipped?: number }>;
  scope?: string;
}
interface ConversationServices {
  database: Database;
  tenantId: string;
  history: { catalog(): Promise<HistoryCatalog> };
  delivery: ContextDelivery;
  execution: {
    targets(): Promise<{ projects: AgentProject[] }>;
    launch(job: Execution): void;
  };
  contextRoot: string;
  summarize?: (snapshot: SessionContext, entries: ContextEntry[], root: string) => Promise<SummaryResult>;
  environment?: Environment;
}
interface ConversationInput {
  requestId?: unknown;
  message?: unknown;
  targetAgent?: unknown;
  deviceId?: unknown;
  projectId?: unknown;
  cwd?: unknown;
  directoryRequestId?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
}
interface ConversationSource {
  session: Session;
  entries: ContextEntry[];
  sources: string[];
  partial: boolean;
  aliases: string[];
}

const active = new Set(['queued', 'launching', 'running', 'waiting', 'unknown']);
const now = () => new Date().toISOString();
const requestKey = (input: ConversationInput) => {
  if (typeof input?.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId)) throw httpError(400, '发送标识无效');
  return input.requestId;
};
const messageText = (value: unknown, optional = false) => {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > 12000 || (!optional && !value.trim())) throw httpError(400, '请输入 1–12000 字符的消息');
  return value.trim();
};

export function createConversations({ database, tenantId, history, delivery, execution, contextRoot, summarize, environment = {} }: ConversationServices) {
  const read = () => database.readTaskCenter(tenantId);
  const managed = (id: string, data = read()) => data.sessions.find((session): session is ManagedSession => session.id === id && session.source === 'conversation');
  const remoteSource = (session: ManagedSession, data: TaskCenterData): RemoteContextHandoff => {
    let id = session.sourceSessionId;
    let sourceFreezeId = session.id;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const source = data.sessions.find(item => item.id === id);
      if (!source) break;
      if (source.source !== 'conversation') {
        if (source.deviceId !== (session.contextSourceDeviceId || session.deviceId) || !source.nativeId) break;
        return { sourceNativeId: source.nativeId, sourceAgent: source.agent, sourceDeviceId: source.deviceId,
          sourceCwd: source.cwd, sourceSessionId: source.id, sourceFreezeId, contextDigest: '' };
      }
      sourceFreezeId = source.id;
      id = source.sourceSessionId || '';
    }
    throw httpError(409, '远端原始会话来源不可核对，无法生成完整交接文件');
  };
  const jobsFor = (data: TaskCenterData, id: string) => data.executions.filter(job => job.conversationId === id);
  const clean = (value: unknown): Record<string, unknown> => {
    const record = deliverRecord('context', value, environment).record;
    return record && typeof record === 'object' && !Array.isArray(record) ? record as Record<string, unknown> : {};
  };
  function busy(data: TaskCenterData, taskId: string) {
    return data.executions.some(job => job.taskId === taskId && (active.has(job.status) || job.releaseStatus === 'releasing')) ||
      data.handoffs.some(handoff => handoff.taskId === taskId && handoff.mode === 'continue' && ['pending', 'received'].includes(handoff.status));
  }
  function currentMessages(data: TaskCenterData, id: string): HistoryMessage[] {
    return jobsFor(data, id).flatMap(job => [
      { role: 'user', text: job.userMessage, timestamp: job.createdAt, turnId: job.id },
      ...(job.output ? [{ role: 'assistant', text: job.output, timestamp: job.updatedAt, turnId: job.id }] : [])
    ]);
  }
  async function source(id: string): Promise<ConversationSource> {
    const data = read(), own = managed(id, data);
    if (own) {
      if (own.preparationError) throw httpError(409, own.preparationError);
      const prior = database.readSessionContext(tenantId, own.contextId);
      if (!prior) throw httpError(409, '继承上下文不可用');
      const entries: ContextEntry[] = [...prior.entries];
      for (const job of jobsFor(data, id)) {
        entries.push({ role: 'user', text: String(clean({ text: job.userMessage })?.text || ''), source: id, timestamp: job.createdAt });
        for (const event of job.contextEvents || []) entries.push({ role: 'tool_result', text: JSON.stringify(clean(event)), source: id });
        if (job.output) entries.push({ role: 'assistant', text: String(clean({ text: job.output })?.text || ''), source: id, timestamp: job.updatedAt });
      }
      return { session: own, entries, sources: [...prior.sources, id], partial: prior.partial, aliases: [id] };
    }
    const saved = data.sessions.find(session => session.id === id);
    if (saved?.deviceId && saved.deviceId !== 'local') {
      return { session: saved, entries: [{ role: 'reference', text: saved.excerpt ? String(clean({ text: saved.excerpt })?.text || '') : '完整原始会话将在来源设备的连接器上读取', source: id }], sources: [id], partial: true, aliases: [id] };
    }
    const catalog = await history.catalog();
    const original = catalog.sessions.find(session => session.id === id || (saved && session.sessionId === saved.nativeId && session.agent === saved.agent));
    if (!original) throw httpError(404, '会话来源不存在或无法读取');
    const owner = data.sessions.find(session => session.source === 'conversation' && session.deviceId === 'local' && session.agent === original.agent && session.nativeId === original.sessionId);
    if (owner) return source(owner.id);
    const result = await readContext(delivery, original.id);
    const aliases = [id, original.id, ...data.sessions.filter(session => session.deviceId === 'local' && session.agent === original.agent && session.nativeId === original.sessionId).map(session => session.id)];
    return { session: { ...original, deviceId: 'local' }, ...result, sources: [original.id], aliases };
  }
  let preparing = false, closed = false;
  const service = {
    close() { closed = true; },
    has: (id: string) => Boolean(managed(id)),
    list() { return read().sessions.filter(session => session.source === 'conversation'); },
    async historyList(params = new URLSearchParams()) {
      const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 30);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw httpError(400, '分页参数无效');
      const q = (params.get('q') || '').trim().toLowerCase(), agent = params.get('agent') || '', workspace = params.get('workspace') || '';
      if (q.length > 200) throw httpError(400, '搜索词不能超过 200 字符');
      const catalog = await history.catalog(), data = read();
      const continued = data.sessions.filter(session => session.source === 'conversation');
      const nativeKeys = new Set(continued.filter(session => session.nativeId).map(session => `${session.deviceId}:${session.agent}:${session.nativeId}`));
      const remote = data.sessions.filter(session => session.deviceId !== 'local' && session.source !== 'conversation' && !nativeKeys.has(`${session.deviceId}:${session.agent}:${session.nativeId}`));
      const added = [...continued, ...remote].map(session => ({ ...session, sessionId: session.nativeId, workspaces: session.cwd ? [session.cwd] : [], model: '', branch: '', messageCount: session.source === 'conversation' ? currentMessages(data, session.id).length : session.excerpt ? 1 : 0 }));
      const sessions = [...catalog.sessions.filter(session => !nativeKeys.has(`local:${session.agent}:${session.sessionId}`)), ...added];
      const providers = [...(catalog.providers || [])];
      for (const session of added) if (!providers.some(provider => provider.id === session.agent)) providers.push({ id: session.agent, label: session.agentLabel || session.agent, status: 'available' });
      if (agent && !providers.some(provider => provider.id === agent)) throw httpError(400, '不支持的 Agent');
      const counts = new Map<string, number>();
      for (const session of sessions.filter(session => !agent || session.agent === agent)) for (const cwd of session.workspaces?.length ? session.workspaces : ['__unknown__']) counts.set(cwd, (counts.get(cwd) || 0) + 1);
      const matches = sessions.filter(session => (!agent || session.agent === agent) && (!workspace || (workspace === '__unknown__' ? !session.workspaces?.length : session.workspaces?.includes(workspace))) && (!q || [session.title, session.cwd, session.nativeId, session.sessionId, session.model, session.branch].some(value => String(value || '').toLowerCase().includes(q))))
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.id.localeCompare(right.id));
      return { sessions: matches.slice(offset, offset + limit), total: matches.length, offset, limit, providers, scope: catalog.scope, workspace, workspaces: [...counts].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path)) };
    },
    remoteDetail(id: string, params = new URLSearchParams()) {
      const s = read().sessions.find(session => session.id === id && session.deviceId !== 'local' && session.source !== 'conversation');
      if (!s) return null;
      const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 100);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw httpError(400, '分页参数无效');
      const messages = s.excerpt ? [{ role: 'assistant', text: s.excerpt, timestamp: s.updatedAt }] : [];
      return { session: { ...s, sessionId: s.nativeId, partial: true }, messages: messages.slice(offset, offset + limit), total: messages.length, offset, limit };
    },
    detail(id: string, params = new URLSearchParams()) {
      const data = read(), session = managed(id, data);
      if (!session) throw httpError(404, '会话不存在');
      const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 100);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw httpError(400, '分页参数无效');
      const messages = currentMessages(data, id), context = database.readSessionContext(tenantId, session.contextId);
      const inheritedCount = context ? cleanContextEntries(context.entries).length : 0;
      return { session: { ...session, managed: true, sessionId: session.nativeId }, messages: messages.slice(offset, offset + limit), total: messages.length, offset, limit,
        inherited: { sourceSessionId: session.sourceSessionId, count: inheritedCount, partial: session.deviceId !== 'local' ? session.partial || false : context?.partial || false, digest: context?.digest } };
    },
    inherited(id: string, params = new URLSearchParams()) {
      const session = managed(id);
      if (!session) throw httpError(404, '会话不存在');
      const context = database.readSessionContext(tenantId, session.contextId);
      if (!context) throw httpError(409, '继承上下文不可用');
      const offset = Number(params.get('offset') || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw httpError(400, '分页参数无效');
      const entries = cleanContextEntries(context.entries);
      return { messages: entries.slice(offset, offset + 100).map(entry => ({ ...entry, role: ['user', 'assistant', 'tool_call', 'tool_result'].includes(entry.role) ? entry.role : 'tool_result' })), total: entries.length, offset, digest: context.digest };
    },
    transfer(id: string, executionId: string, action: 'read' | 'upload', actor: { id?: string }, input?: { deviceId?: unknown; context?: unknown; bundle?: unknown; format?: unknown; readyOnly?: unknown; failure?: unknown }) {
      const data = read(), job = data.executions?.find(item => item.id === executionId && item.conversationId === id);
      if (!job || !job.contextSourceDeviceId || job.contextSourceDeviceId === job.deviceId || !managed(id, data)) throw httpError(404, '跨设备交接不存在');
      const deviceId = action === 'upload' ? job.contextSourceDeviceId : job.deviceId;
      const device = data.devices.find(item => item.id === deviceId);
      if (deviceId === 'local' || !actor.id || !device || device.owner !== actor.id || input?.deviceId !== deviceId) throw httpError(403, '当前账号无权访问该设备的交接包');
      if (action === 'upload' && (!job.remoteContext || job.remoteContext.sourceDeviceId !== deviceId)) throw httpError(409, '交接来源不在该设备');
      const contextId = job.contextSourceDeviceId === 'local' ? job.contextId! : job.id;
      if (action === 'upload') {
        if (job.status !== 'queued' && !database.readSessionContext(tenantId, contextId)) throw httpError(409, '执行已不再等待交接包');
        if (typeof input?.failure === 'string') {
          if (!input.failure || input.failure.length > 2000) throw httpError(400, '交接失败信息无效');
          if (database.readSessionContext(tenantId, contextId)) return { ready: true };
          database.recordContextTransferFailure(tenantId, executionId, job.contextSourceDeviceId, job.deviceId, contextId, job.contextDigest || '', input.failure);
          database.mutateTaskCenter(tenantId, current => {
            const saved = current.executions.find(item => item.id === executionId);
            if (saved && saved.status === 'queued') saved.contextTransferError = input.failure as string;
          });
          return { ready: false, failed: true };
        }
        let value: SessionContext;
        try {
          value = input?.bundle ? verifyBundle(input.bundle).snapshot : verifySnapshot(input?.context);
          if (input?.bundle && input.context && verifySnapshot(input.context).digest !== value.digest) throw new Error('交接包和旧版快照不一致');
        } catch { throw httpError(400, '交接快照校验失败'); }
        if (!value.sources.includes(job.remoteContext!.sourceSessionId)) throw httpError(400, '交接快照缺少原始来源');
        const existing = database.readSessionContext(tenantId, contextId);
        if (existing && existing.digest !== value.digest) throw httpError(409, '交接快照已冻结，不能覆盖');
        try {
          database.recordContextTransfer(tenantId, executionId, job.contextSourceDeviceId, job.deviceId, existing || value, contextId);
        }
        catch { throw httpError(409, '交接记录已冻结，不能覆盖'); }
        database.mutateTaskCenter(tenantId, current => {
          const session = managed(id, current);
          if (session && session.contextId === job.contextId) { session.contextId = contextId; session.contextTransferred = true; session.partial = value.partial; session.updatedAt = now(); }
          const saved = current.executions.find(item => item.id === executionId);
          if (saved && saved.status === 'queued') delete saved.contextTransferError;
        });
        return { ready: true, digest: value.digest };
      }
      const snapshot = database.readSessionContext(tenantId, contextId);
      if (!snapshot) return { ready: false };
      const bundle = database.recordContextTransfer(tenantId, executionId, job.contextSourceDeviceId, job.deviceId, snapshot);
      return { ready: true, ...(input?.readyOnly === '1' ? {} : input?.format === 'bundle-v2' ? { bundle } : { context: snapshot }) };
    },
    status(id: string) {
      if (!managed(id)) throw httpError(404, '会话不存在');
      const executions = jobsFor(read(), id).map(job => ({ ...job, prompt: job.userMessage }));
      const session = managed(id);
      if (!session) throw httpError(404, '会话不存在');
      const unresolved = session.status === 'preparing' && read().executions.find(job => job.taskId === session.taskId && job.status === 'unknown');
      if (unresolved) return { executions, execution: { ...unresolved, message: '来源执行结果待核对，确认结束后将自动继续准备上下文', prompt: '' } };
      return { executions, execution: session.preparationError ? { status: 'failed', message: session.preparationError, prompt: session.pendingMessage || '' } : session.status === 'preparing' ? { status: 'queued', message: '等待来源本轮结束，随后自动带上上下文', prompt: '' } : executions.at(-1) || null };
    },
    async create(id: string, input: ConversationInput, actor: { id?: string } = {}) {
      const requestId = requestKey(input), message = messageText(input.message, true);
      if (typeof input.targetAgent !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.targetAgent)) throw httpError(400, '请选择目标 Agent');
      const targetAgent = input.targetAgent;
      if (input.deviceId !== undefined && (typeof input.deviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.deviceId))) throw httpError(400, '目标设备格式无效');
      if (input.projectId !== undefined && (typeof input.projectId !== 'string' || input.projectId.length > 500)) throw httpError(400, '执行目标格式无效');
      if (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd.length > 2000)) throw httpError(400, '工作目录格式无效');
      if (input.directoryRequestId !== undefined && (typeof input.directoryRequestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.directoryRequestId))) throw httpError(400, '目录选择标识无效');
      if (input.model !== undefined && (typeof input.model !== 'string' || input.model.length > 200)) throw httpError(400, '模型格式无效');
      if (input.reasoningEffort !== undefined && (typeof input.reasoningEffort !== 'string' || input.reasoningEffort.length > 80)) throw httpError(400, '思考强度格式无效');
      const projectId = typeof input.projectId === 'string' ? input.projectId : '';
      const targetDeviceId = typeof input.deviceId === 'string' ? input.deviceId : '';
      const requestedCwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
      const directoryRequestId = typeof input.directoryRequestId === 'string' ? input.directoryRequestId : '';
      const model = typeof input.model === 'string' ? input.model.trim() : '';
      const reasoningEffort = typeof input.reasoningEffort === 'string' ? input.reasoningEffort.trim() : '';
      const fingerprint = createHash('sha256').update(JSON.stringify([id, targetAgent, targetDeviceId, projectId, requestedCwd, directoryRequestId, model, reasoningEffort, message])).digest('hex');
      const repeated = read().sessions.find(session => session.createRequestId === requestId);
      if (repeated) {
        if (repeated.createFingerprint !== fingerprint) throw httpError(409, '发送标识已用于另一请求');
        if (message && repeated.status !== 'preparing') await this.send(repeated.id, { requestId, message });
        return { sessionId: repeated.id, taskId: repeated.taskId };
      }
      const origin = await source(id);
      const originDeviceId = origin.session.deviceId || 'local';
      const allProjects = (await execution.targets()).projects.filter(project => (project.agent || 'codex') === targetAgent && project.deviceId === (targetDeviceId || originDeviceId));
      const project = projectId ? allProjects.find(item => item.id === projectId) : allProjects.find(item => item.cwd === origin.session.cwd) || allProjects[0];
      if (!project) throw httpError(projectId ? 400 : 422, projectId ? '请选择可用执行目标' : `来源设备上没有可用的 ${targetAgent}，请配置该 Agent 后重试`);
      const deviceId = project.deviceId || 'local';
      const sourceDeviceId = originDeviceId;
      const contextSourceDeviceId = origin.session.source === 'conversation' && (origin.session.contextTransferred || origin.session.contextSourceDeviceId === 'local') ? 'local' : sourceDeviceId;
      if (deviceId !== sourceDeviceId && !requestedCwd) throw httpError(400, '跨设备交接请明确选择目标设备的工作目录');
      const selectedModel = (project.models || []).find(item => item.id === model);
      if (model && !selectedModel) throw httpError(400, '所选模型不属于目标 Agent');
      const efforts = Array.isArray(selectedModel?.reasoningEfforts) ? selectedModel.reasoningEfforts : project.reasoningEfforts || [];
      if (reasoningEffort && !efforts.some(item => item.id === reasoningEffort)) throw httpError(400, '所选思考强度不受当前模型支持');
      let cwd = requestedCwd || (deviceId === sourceDeviceId ? origin.session.cwd : '') || project.cwd;
      if (deviceId !== 'local' && cwd !== project.cwd) {
        const selection = read().directoryRequests?.find(item => item.id === directoryRequestId);
        if (!selection || selection.status !== 'completed' || selection.requestedBy !== actor.id || selection.deviceId !== deviceId || selection.projectId !== project.id || selection.cwd !== cwd) throw httpError(409, '请在目标设备重新选择工作目录');
      }
      if (deviceId === 'local') {
        try { cwd = await realpath(cwd); if (!(await stat(cwd)).isDirectory()) throw new Error(); }
        catch { throw httpError(409, '目标工作目录已不可用'); }
      }
      let snapshot = freezeContext(origin.entries, origin.sources, origin.partial);
      const result = database.mutateTaskCenter(tenantId, data => {
        const duplicate = data.sessions.find(session => session.createRequestId === requestId);
        if (duplicate) {
          if (duplicate.createFingerprint !== fingerprint) throw httpError(409, '发送标识已用于另一请求');
          return { sessionId: duplicate.id, taskId: duplicate.taskId, duplicate: true };
        }
        let task = data.tasks.find(candidate => candidate.sessionIds.some(sessionId => origin.aliases.includes(sessionId)));
        if (task) {
          const taskId = task.id;
          if (data.executions.some(job => job.taskId === taskId && job.status === 'unknown')) throw httpError(409, '来源执行结果待核对，请先核对原会话');
        }
        const waiting = task && busy(data, task.id);
        if (!task) {
          task = { id: randomUUID(), title: origin.session.title, content: origin.session.title, status: 'ready', revision: 1, contextVersion: 1, sessionIds: [id], events: [], createdAt: now(), updatedAt: now() };
          data.tasks.push(task);
        } else {
          const taskId = task.id;
          snapshot = freezeContext([{ role: 'reference', text: String(clean({ text: taskContent(task) })?.text || ''), source: `task:${taskId}` }, ...snapshot.entries.filter(entry => entry.source !== `task:${taskId}`)], snapshot.sources, snapshot.partial);
        }
        if (!task) throw httpError(409, '会话关联任务不存在');
        database.saveSessionContext(tenantId, snapshot);
        const sessionId = createHash('sha256').update(randomUUID()).digest('hex');
        data.sessions.push({ id: sessionId, source: 'conversation', managed: true, taskId: task.id, sourceSessionId: id, contextSourceDeviceId, contextId: snapshot.id, createRequestId: requestId, createFingerprint: fingerprint,
          agent: targetAgent, agentLabel: targetAgent === 'codex' ? 'Codex' : targetAgent === 'claude' ? 'Claude Code' : targetAgent, model: model || undefined, reasoningEffort: reasoningEffort || undefined,
          deviceId, projectId: project.id, directoryRequestId: directoryRequestId || undefined, appServerProjectId: project.appServerProjectId, protocol: project.protocol || 'legacy', cwd, nativeId: null,
          title: origin.session.title, status: waiting ? 'preparing' : 'ready', pendingMessage: message, pendingRequestId: requestId, partial: snapshot.partial, createdAt: now(), updatedAt: now(), excerpt: '' });
        task.sessionIds.push(sessionId); task.revision++; task.updatedAt = now();
        task.events.unshift({ id: randomUUID(), at: now(), message: `带上下文新开 ${targetAgent} 会话` });
        return { sessionId, taskId: task.id, duplicate: false };
      });
      const created = managed(result.sessionId);
      if (!created) throw httpError(409, '会话创建失败');
      if (message && created.status !== 'preparing') await this.send(result.sessionId, { requestId, message });
      return { sessionId: result.sessionId, taskId: result.taskId };
    },
    async send(id: string, input: ConversationInput) {
      const requestId = requestKey(input), message = messageText(input.message);
      const data = read(), session = managed(id, data);
      if (!session) throw httpError(404, '会话不存在');
      if (session.preparationError) throw httpError(409, session.preparationError);
      if (session.status === 'preparing') throw httpError(409, '正在等待来源会话结束，稍后自动准备好上下文');
      const prior = data.executions.find(job => job.requestId === requestId);
      if (prior) {
        if (prior.conversationId !== id || prior.userMessage !== message) throw httpError(409, '发送标识已用于另一条消息');
        return { executionId: prior.id, taskId: session.taskId };
      }
      const snapshot = database.readSessionContext(tenantId, session.contextId);
      if (!snapshot) throw httpError(409, '继承上下文不可用');
      const first = !session.nativeId;
      const crossDevice = first && Boolean(session.contextSourceDeviceId && session.contextSourceDeviceId !== session.deviceId);
      const compiled = first && session.deviceId === 'local' && !crossDevice ? await contextPrompt(snapshot, message, contextRoot, 120000, true, summarize) : { prompt: message, compacted: false, images: [], markdownPath: '' };
      const remote = first && (session.contextSourceDeviceId || session.deviceId) !== 'local' ? remoteSource(session, data) : null;
      const job = database.mutateTaskCenter(tenantId, current => {
        const duplicate = current.executions.find(candidate => candidate.requestId === requestId);
        if (duplicate) {
          if (duplicate.conversationId !== id || duplicate.userMessage !== message) throw httpError(409, '发送标识已用于另一条消息');
          return { ...duplicate, replay: true };
        }
        const s = managed(id, current);
        if (!s) throw httpError(404, '会话不存在');
        const task = current.tasks.find(candidate => candidate.id === s.taskId);
        if (!task) throw httpError(409, '会话关联任务不存在');
        if (busy(current, task.id)) throw httpError(409, '请等待当前执行完成，结果未知时先核对原会话');
        if (s.nativeId !== session.nativeId) throw httpError(409, '会话已更新，请重试');
        const j: Execution = { id: randomUUID(), requestId, conversationId: id, sourceSessionId: s.sourceSessionId, contextSourceDeviceId: s.contextSourceDeviceId, contextId: s.contextId, contextDigest: snapshot.digest,
          contextCompacted: compiled.compacted, taskId: task.id, contextVersion: task.contextVersion, userMessage: message, prompt: compiled.prompt,
          ...(s.deviceId === 'local' && compiled.markdownPath ? { contextMarkdownPath: compiled.markdownPath } : {}),
          ...(remote ? { remoteContext: { ...remote, contextDigest: snapshot.digest } } : {}),
          ...(compiled.images.length ? { promptImages: compiled.images } : {}),
          agent: s.agent, agentLabel: s.agentLabel, deviceId: s.deviceId, cwd: s.cwd, projectId: s.projectId, directoryRequestId: s.directoryRequestId, appServerProjectId: s.appServerProjectId, protocol: s.protocol, model: s.model || null, reasoningEffort: s.reasoningEffort || null,
          ...(s.nativeId ? s.protocol === 'acp' ? { resumeSessionId: s.nativeId } : { resumeThreadId: s.nativeId } : {}),
          title: s.title, status: 'queued', createdAt: now(), updatedAt: now(), output: '', message: '已提交消息', sessionId: null, threadId: null, turnId: null };
        (current.executions ||= []).push(j); s.pendingMessage = ''; s.pendingRequestId = null; s.status = 'queued'; s.updatedAt = now(); task.status = 'running'; task.revision++;
        return j;
      });
      if (!job.replay && !(job.deviceId === 'local' && crossDevice)) execution.launch(job);
      return { executionId: job.id, taskId: session.taskId };
    },
    async preparePending() {
      if (preparing || closed) return;
      preparing = true;
      try {
        for (const job of read().executions.filter(item => item.deviceId === 'local' && item.contextSourceDeviceId && item.contextSourceDeviceId !== 'local' && item.status === 'queued')) {
          if (closed || !job.conversationId) return;
          const transferred = database.readSessionContext(tenantId, job.id);
          if (!transferred && !job.contextTransferError) continue;
          try {
            if (job.contextTransferError) throw new Error(job.contextTransferError);
            if (!transferred) throw new Error('跨设备交接包不可用');
            const compiled = await contextPrompt(transferred, job.userMessage || '', contextRoot, 120000, true, summarize);
            const ready = database.mutateTaskCenter(tenantId, data => {
              const saved = data.executions.find(item => item.id === job.id);
              if (!saved || saved.status !== 'queued') return null;
              Object.assign(saved, { prompt: compiled.prompt, promptImages: compiled.images, contextMarkdownPath: compiled.markdownPath, contextSourcePartial: transferred.partial,
                status: 'launching', message: '交接包已送达，正在启动本机 Agent', updatedAt: now() });
              return structuredClone(saved);
            });
            if (ready) execution.launch(ready);
          } catch (caught: unknown) {
            database.mutateTaskCenter(tenantId, data => {
              const saved = data.executions.find(item => item.id === job.id);
              if (saved?.status === 'queued') { saved.status = 'failed'; saved.message = `跨设备交接失败：${caught instanceof Error ? caught.message : String(caught)}`; saved.updatedAt = now(); }
              const session = managed(job.conversationId!, data);
              if (session && saved?.status === 'failed') { session.status = 'error'; session.preparationError = saved.message; }
              const task = data.tasks.find(item => item.id === job.taskId);
              if (task && saved?.status === 'failed') { task.status = 'error'; task.revision++; task.updatedAt = now(); }
            });
          }
        }
        for (const pending of read().sessions.filter((session): session is ManagedSession => session.source === 'conversation' && (session.status === 'preparing' || (session.status === 'ready' && Boolean(session.pendingMessage))))) {
          if (busy(read(), pending.taskId)) continue;
          try {
            if (pending.status === 'ready') {
              await service.send(pending.id, { message: pending.pendingMessage, requestId: pending.pendingRequestId });
              continue;
            }
            const origin = await source(pending.sourceSessionId);
            if (closed) return;
            const task = read().tasks.find(candidate => candidate.id === pending.taskId);
            if (!task) throw httpError(409, '会话关联任务不存在');
            const updated = freezeContext([{ role: 'reference', text: String(clean({ text: taskContent(task) })?.text || ''), source: `task:${task.id}` }, ...origin.entries.filter((e: ContextEntry) => e.source !== `task:${task.id}`)], origin.sources, origin.partial);
            const ready = database.mutateTaskCenter(tenantId, data => {
              const session = managed(pending.id, data);
              if (!session) return false;
              if (session.status !== 'preparing' || busy(data, session.taskId)) return false;
              database.saveSessionContext(tenantId, updated);
              session.contextId = updated.id;
              if (origin.session.source === 'conversation' && (origin.session.contextTransferred || origin.session.contextSourceDeviceId === 'local')) session.contextSourceDeviceId = 'local';
              session.status = 'ready'; session.updatedAt = now();
              return true;
            });
            if (ready && pending.pendingMessage) await service.send(pending.id, { message: pending.pendingMessage, requestId: pending.pendingRequestId });
          } catch (error: unknown) {
            if (closed) return;
            const message = error instanceof Error ? error.message : String(error);
            database.mutateTaskCenter(tenantId, data => { const session = managed(pending.id, data); if (session) { session.status = 'error'; session.preparationError = message; } });
          }
        }
      } finally { preparing = false; }
    }
  };
  return service;
}
