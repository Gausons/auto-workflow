import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { taskContent } from '../public/taskContent.js';
import type { AgentProject, Execution, HistoryMessage, Session, TaskCenterData } from '../public/taskTypes.js';
import { cleanContextEntries, contextPrompt, freezeContext, readContext, type ContextDelivery, type ContextEntry, type SessionContext } from './contextCompiler.js';
import type { SummaryResult } from './contextModelSummary.js';
import type { Environment } from './issueSources/types.js';
import { deliverRecord } from './sessionDelivery/records.js';
import { httpError } from './rbac.js';

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
  projectId?: unknown;
  cwd?: unknown;
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
      if (!saved.excerpt) throw httpError(409, '来源设备尚未同步会话正文，请先启用正文同步');
      return { session: saved, entries: [{ role: 'reference', text: String(clean({ text: saved.excerpt })?.text || ''), source: id }], sources: [id], partial: true, aliases: [id] };
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
        inherited: { sourceSessionId: session.sourceSessionId, count: inheritedCount, partial: context?.partial || false, digest: context?.digest } };
    },
    inherited(id: string, params = new URLSearchParams()) {
      const session = managed(id);
      if (!session) throw httpError(404, '会话不存在');
      const context = database.readSessionContext(tenantId, session.contextId);
      if (!context) throw httpError(409, '继承上下文不可用');
      const offset = Number(params.get('offset') || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw httpError(400, '分页参数无效');
      const entries = cleanContextEntries(context.entries);
      return { messages: entries.slice(offset, offset + 100).map(entry => ({ ...entry, role: ['user', 'assistant', 'tool_call', 'tool_result'].includes(entry.role) ? entry.role : 'tool_result' })), total: entries.length, offset };
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
    async create(id: string, input: ConversationInput) {
      const requestId = requestKey(input), message = messageText(input.message, true);
      if (typeof input.targetAgent !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.targetAgent)) throw httpError(400, '请选择目标 Agent');
      const targetAgent = input.targetAgent;
      if (input.projectId !== undefined && (typeof input.projectId !== 'string' || input.projectId.length > 500)) throw httpError(400, '执行目标格式无效');
      if (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd.length > 2000)) throw httpError(400, '工作目录格式无效');
      if (input.model !== undefined && (typeof input.model !== 'string' || input.model.length > 200)) throw httpError(400, '模型格式无效');
      if (input.reasoningEffort !== undefined && (typeof input.reasoningEffort !== 'string' || input.reasoningEffort.length > 80)) throw httpError(400, '思考强度格式无效');
      const projectId = typeof input.projectId === 'string' ? input.projectId : '';
      const requestedCwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
      const model = typeof input.model === 'string' ? input.model.trim() : '';
      const reasoningEffort = typeof input.reasoningEffort === 'string' ? input.reasoningEffort.trim() : '';
      const fingerprint = createHash('sha256').update(JSON.stringify([id, targetAgent, projectId, requestedCwd, model, reasoningEffort, message])).digest('hex');
      const repeated = read().sessions.find(session => session.createRequestId === requestId);
      if (repeated) {
        if (repeated.createFingerprint !== fingerprint) throw httpError(409, '发送标识已用于另一请求');
        if (message && repeated.status !== 'preparing') await this.send(repeated.id, { requestId, message });
        return { sessionId: repeated.id, taskId: repeated.taskId };
      }
      const origin = await source(id);
      // Keep code and attachments at the same location. Cross-device copying is not implicit.
      const deviceId = origin.session.deviceId || 'local';
      const projects = (await execution.targets()).projects.filter(project => project.deviceId === deviceId && (project.agent || 'codex') === targetAgent);
      const project = (projectId ? projects.find(project => project.id === projectId) : undefined) || projects.find(project => project.cwd === origin.session.cwd) || projects[0];
      if (!project) throw httpError(422, `来源设备上没有可用的 ${targetAgent}，请配置该 Agent 后重试`);
      if (projectId && project.id !== projectId) throw httpError(400, '请选择来源设备上的可用执行目标');
      const selectedModel = (project.models || []).find(item => item.id === model);
      if (model && !selectedModel) throw httpError(400, '所选模型不属于目标 Agent');
      const efforts = Array.isArray(selectedModel?.reasoningEfforts) ? selectedModel.reasoningEfforts : project.reasoningEfforts || [];
      if (reasoningEffort && !efforts.some(item => item.id === reasoningEffort)) throw httpError(400, '所选思考强度不受当前模型支持');
      let cwd = requestedCwd || origin.session.cwd || project.cwd;
      if (deviceId !== 'local' && cwd !== project.cwd) throw httpError(409, '来源目录尚未注册为目标设备的可执行项目');
      if (deviceId === 'local') {
        try { cwd = await realpath(cwd); if (!(await stat(cwd)).isDirectory()) throw new Error(); }
        catch { throw httpError(409, '原会话工作目录已不可用'); }
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
        data.sessions.push({ id: sessionId, source: 'conversation', managed: true, taskId: task.id, sourceSessionId: id, contextId: snapshot.id, createRequestId: requestId, createFingerprint: fingerprint,
          agent: targetAgent, agentLabel: targetAgent === 'codex' ? 'Codex' : targetAgent === 'claude' ? 'Claude Code' : targetAgent, model: model || undefined, reasoningEffort: reasoningEffort || undefined,
          deviceId, projectId: project.id, appServerProjectId: project.appServerProjectId, protocol: project.protocol || 'legacy', cwd, nativeId: null,
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
      if (first && session.deviceId !== 'local' && JSON.stringify(snapshot.entries).length > 100000) throw httpError(422, '远端上下文过长，暂无法在目标设备提供完整历史文件');
      const compiled = first ? await contextPrompt(snapshot, message, contextRoot, 120000, session.deviceId === 'local', summarize) : { prompt: message, compacted: false, images: [], markdownPath: '' };
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
        const j: Execution = { id: randomUUID(), requestId, conversationId: id, sourceSessionId: s.sourceSessionId, contextId: s.contextId, contextDigest: snapshot.digest,
          contextCompacted: compiled.compacted, taskId: task.id, contextVersion: task.contextVersion, userMessage: message, prompt: compiled.prompt,
          ...(s.deviceId === 'local' && compiled.markdownPath ? { contextMarkdownPath: compiled.markdownPath } : {}),
          ...(compiled.images.length ? { promptImages: compiled.images } : {}),
          agent: s.agent, agentLabel: s.agentLabel, deviceId: s.deviceId, cwd: s.cwd, projectId: s.projectId, appServerProjectId: s.appServerProjectId, protocol: s.protocol, model: s.model || null, reasoningEffort: s.reasoningEffort || null,
          ...(s.nativeId ? s.protocol === 'acp' ? { resumeSessionId: s.nativeId } : { resumeThreadId: s.nativeId } : {}),
          title: s.title, status: 'queued', createdAt: now(), updatedAt: now(), output: '', message: '已提交消息', sessionId: null, threadId: null, turnId: null };
        (current.executions ||= []).push(j); s.pendingMessage = ''; s.pendingRequestId = null; s.status = 'queued'; s.updatedAt = now(); task.status = 'running'; task.revision++;
        return j;
      });
      if (!job.replay) execution.launch(job);
      return { executionId: job.id, taskId: session.taskId };
    },
    async preparePending() {
      if (preparing || closed) return;
      preparing = true;
      try {
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
              session.contextId = updated.id; session.status = 'ready'; session.updatedAt = now();
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
