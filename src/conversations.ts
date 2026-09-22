import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { taskContent } from '../public/taskContent.js';
import { contextPrompt, freezeContext, readContext, type ContextEntry } from './contextCompiler.js';
import { deliverRecord } from './sessionDelivery/records.js';
import { httpError } from './rbac.js';

const active = new Set(['queued', 'launching', 'running', 'waiting', 'unknown']);
const now = () => new Date().toISOString();
const requestKey = (input: any) => {
  if (typeof input?.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId)) throw httpError(400, '发送标识无效');
  return input.requestId;
};
const messageText = (value: any, optional = false) => {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > 12000 || (!optional && !value.trim())) throw httpError(400, '请输入 1–12000 字符的消息');
  return value.trim();
};

export function createConversations({ database, tenantId, history, delivery, execution, contextRoot, environment = {} }: any) {
  const read = () => database.readTaskCenter(tenantId);
  const managed = (id: string, data = read()) => data.sessions.find((s: any) => s.id === id && s.source === 'conversation');
  const jobsFor = (data: any, id: string) => (data.executions || []).filter((job: any) => job.conversationId === id);
  const clean = (value: any): any => deliverRecord('context', value, environment).record;
  function busy(data: any, taskId: string) {
    return data.executions?.some((j: any) => j.taskId === taskId && (active.has(j.status) || j.releaseStatus === 'releasing')) ||
      data.handoffs.some((h: any) => h.taskId === taskId && h.mode === 'continue' && ['pending', 'received'].includes(h.status));
  }
  function currentMessages(data: any, id: string) {
    return jobsFor(data, id).flatMap((job: any) => [
      { role: 'user', text: job.userMessage, timestamp: job.createdAt, turnId: job.id },
      ...(job.output ? [{ role: 'assistant', text: job.output, timestamp: job.updatedAt, turnId: job.id }] : [])
    ]);
  }
  async function source(id: string): Promise<any> {
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
    const saved = data.sessions.find((s: any) => s.id === id);
    if (saved?.deviceId && saved.deviceId !== 'local') {
      if (!saved.excerpt) throw httpError(409, '来源设备尚未同步会话正文，请先启用正文同步');
      return { session: saved, entries: [{ role: 'reference', text: String(clean({ text: saved.excerpt })?.text || ''), source: id }], sources: [id], partial: true, aliases: [id] };
    }
    const catalog = await history.catalog();
    const original = catalog.sessions.find((s: any) => s.id === id || (saved && s.sessionId === saved.nativeId && s.agent === saved.agent));
    if (!original) throw httpError(404, '会话来源不存在或无法读取');
    const owner = data.sessions.find((s: any) => s.source === 'conversation' && s.deviceId === 'local' && s.agent === original.agent && s.nativeId === original.sessionId);
    if (owner) return source(owner.id);
    const result = await readContext(delivery, original.id);
    const aliases = [id, original.id, ...data.sessions.filter((s: any) => s.deviceId === 'local' && s.agent === original.agent && s.nativeId === original.sessionId).map((s: any) => s.id)];
    return { session: { ...original, deviceId: 'local' }, ...result, sources: [original.id], aliases };
  }
  let preparing = false, closed = false;
  const service = {
    close() { closed = true; },
    has: (id: string) => Boolean(managed(id)),
    list() { return read().sessions.filter((s: any) => s.source === 'conversation'); },
    async historyList(params = new URLSearchParams()) {
      const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 30);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw httpError(400, '分页参数无效');
      const q = (params.get('q') || '').trim().toLowerCase(), agent = params.get('agent') || '', workspace = params.get('workspace') || '';
      if (q.length > 200) throw httpError(400, '搜索词不能超过 200 字符');
      const catalog = await history.catalog(), data = read();
      const continued = data.sessions.filter((s: any) => s.source === 'conversation');
      const nativeKeys = new Set(continued.filter((s: any) => s.nativeId).map((s: any) => `${s.deviceId}:${s.agent}:${s.nativeId}`));
      const remote = data.sessions.filter((s: any) => s.deviceId !== 'local' && s.source !== 'conversation' && !nativeKeys.has(`${s.deviceId}:${s.agent}:${s.nativeId}`));
      const added = [...continued, ...remote].map((s: any) => ({ ...s, sessionId: s.nativeId, workspaces: s.cwd ? [s.cwd] : [], model: '', branch: '', messageCount: s.source === 'conversation' ? currentMessages(data, s.id).length : s.excerpt ? 1 : 0 }));
      const sessions = [...catalog.sessions.filter((s: any) => !nativeKeys.has(`local:${s.agent}:${s.sessionId}`)), ...added];
      const providers = [...catalog.providers];
      for (const s of added) if (!providers.some((p: any) => p.id === s.agent)) providers.push({ id: s.agent, label: s.agentLabel || s.agent, status: 'available' });
      if (agent && !providers.some((p: any) => p.id === agent)) throw httpError(400, '不支持的 Agent');
      const counts = new Map<string, number>();
      for (const s of sessions.filter((s: any) => !agent || s.agent === agent)) for (const cwd of s.workspaces?.length ? s.workspaces : ['__unknown__']) counts.set(cwd, (counts.get(cwd) || 0) + 1);
      const matches = sessions.filter((s: any) => (!agent || s.agent === agent) && (!workspace || (workspace === '__unknown__' ? !s.workspaces?.length : s.workspaces?.includes(workspace))) && (!q || [s.title, s.cwd, s.nativeId, s.sessionId, s.model, s.branch].some(v => String(v || '').toLowerCase().includes(q))))
        .sort((a: any, b: any) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id));
      return { sessions: matches.slice(offset, offset + limit), total: matches.length, offset, limit, providers, scope: catalog.scope, workspace, workspaces: [...counts].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path)) };
    },
    remoteDetail(id: string, params = new URLSearchParams()) {
      const s = read().sessions.find((s: any) => s.id === id && s.deviceId !== 'local' && s.source !== 'conversation');
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
      return { session: { ...session, managed: true, sessionId: session.nativeId }, messages: messages.slice(offset, offset + limit), total: messages.length, offset, limit,
        inherited: { sourceSessionId: session.sourceSessionId, count: context?.entries.length || 0, partial: context?.partial || false, digest: context?.digest } };
    },
    inherited(id: string, params = new URLSearchParams()) {
      const session = managed(id);
      if (!session) throw httpError(404, '会话不存在');
      const context = database.readSessionContext(tenantId, session.contextId);
      const offset = Number(params.get('offset') || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw httpError(400, '分页参数无效');
      return { messages: context.entries.slice(offset, offset + 100).map((e: any) => ({ ...e, role: ['user', 'assistant', 'tool_call', 'tool_result'].includes(e.role) ? e.role : 'tool_result' })), total: context.entries.length, offset };
    },
    status(id: string) {
      if (!managed(id)) throw httpError(404, '会话不存在');
      const executions = jobsFor(read(), id).map((job: any) => ({ ...job, prompt: job.userMessage }));
      const session = managed(id);
      const unresolved = session.status === 'preparing' && read().executions?.find((j: any) => j.taskId === session.taskId && j.status === 'unknown');
      if (unresolved) return { executions, execution: { ...unresolved, message: '来源执行结果待核对，确认结束后将自动继续准备上下文', prompt: '' } };
      return { executions, execution: session.preparationError ? { status: 'failed', message: session.preparationError, prompt: session.pendingMessage || '' } : session.status === 'preparing' ? { status: 'queued', message: '等待来源本轮结束，随后自动带上上下文', prompt: '' } : executions.at(-1) || null };
    },
    async create(id: string, input: any) {
      const requestId = requestKey(input), message = messageText(input.message, true);
      if (typeof input.targetAgent !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.targetAgent)) throw httpError(400, '请选择目标 Agent');
      const fingerprint = createHash('sha256').update(JSON.stringify([id, input.targetAgent, message])).digest('hex');
      const repeated = read().sessions.find((s: any) => s.createRequestId === requestId);
      if (repeated) {
        if (repeated.createFingerprint !== fingerprint) throw httpError(409, '发送标识已用于另一请求');
        if (message && repeated.status !== 'preparing') await this.send(repeated.id, { requestId, message });
        return { sessionId: repeated.id, taskId: repeated.taskId };
      }
      const origin = await source(id);
      // Keep code and attachments at the same location. Cross-device copying is not implicit.
      const deviceId = origin.session.deviceId || 'local';
      const projects = (await execution.targets()).projects.filter((p: any) => p.deviceId === deviceId && (p.agent || 'codex') === input.targetAgent);
      const project = projects.find((p: any) => p.cwd === origin.session.cwd) || projects[0];
      if (!project) throw httpError(422, `来源设备上没有可用的 ${input.targetAgent}，请配置该 Agent 后重试`);
      let cwd = origin.session.cwd || project.cwd;
      if (deviceId !== 'local' && cwd !== project.cwd) throw httpError(409, '来源目录尚未注册为目标设备的可执行项目');
      if (deviceId === 'local') {
        try { cwd = await realpath(cwd); if (!(await stat(cwd)).isDirectory()) throw new Error(); }
        catch { throw httpError(409, '原会话工作目录已不可用'); }
      }
      let snapshot = freezeContext(origin.entries, origin.sources, origin.partial);
      const result = database.mutateTaskCenter(tenantId, (data: any) => {
        const duplicate = data.sessions.find((s: any) => s.createRequestId === requestId);
        if (duplicate) {
          if (duplicate.createFingerprint !== fingerprint) throw httpError(409, '发送标识已用于另一请求');
          return { sessionId: duplicate.id, taskId: duplicate.taskId, duplicate: true };
        }
        let task = data.tasks.find((t: any) => t.sessionIds.some((sid: string) => origin.aliases.includes(sid)));
        if (task && data.executions?.some((j: any) => j.taskId === task.id && j.status === 'unknown')) throw httpError(409, '来源执行结果待核对，请先核对原会话');
        const waiting = task && busy(data, task.id);
        if (!task) {
          task = { id: randomUUID(), title: origin.session.title, content: origin.session.title, status: 'ready', revision: 1, contextVersion: 1, sessionIds: [id], events: [], createdAt: now(), updatedAt: now() };
          data.tasks.push(task);
        } else {
          snapshot = freezeContext([{ role: 'reference', text: String(clean({ text: taskContent(task) })?.text || ''), source: `task:${task.id}` }, ...snapshot.entries.filter(e => e.source !== `task:${task.id}`)], snapshot.sources, snapshot.partial);
        }
        database.saveSessionContext(tenantId, snapshot);
        const sessionId = createHash('sha256').update(randomUUID()).digest('hex');
        data.sessions.push({ id: sessionId, source: 'conversation', managed: true, taskId: task.id, sourceSessionId: id, contextId: snapshot.id, createRequestId: requestId, createFingerprint: fingerprint,
          agent: input.targetAgent, agentLabel: input.targetAgent === 'codex' ? 'Codex' : input.targetAgent === 'claude' ? 'Claude Code' : input.targetAgent,
          deviceId, projectId: project.id, appServerProjectId: project.appServerProjectId, protocol: project.protocol || 'legacy', cwd, nativeId: null,
          title: origin.session.title, status: waiting ? 'preparing' : 'ready', pendingMessage: message, pendingRequestId: requestId, partial: snapshot.partial, createdAt: now(), updatedAt: now(), excerpt: '' });
        task.sessionIds.push(sessionId); task.revision++; task.updatedAt = now();
        task.events.unshift({ id: randomUUID(), at: now(), message: `带上下文新开 ${input.targetAgent} 会话` });
        return { sessionId, taskId: task.id, duplicate: false };
      });
      if (message && managed(result.sessionId).status !== 'preparing') await this.send(result.sessionId, { requestId, message });
      return { sessionId: result.sessionId, taskId: result.taskId };
    },
    async send(id: string, input: any) {
      const requestId = requestKey(input), message = messageText(input.message);
      const data = read(), session = managed(id, data);
      if (!session) throw httpError(404, '会话不存在');
      if (session.preparationError) throw httpError(409, session.preparationError);
      if (session.status === 'preparing') throw httpError(409, '正在等待来源会话结束，稍后自动准备好上下文');
      const prior = data.executions?.find((j: any) => j.requestId === requestId);
      if (prior) {
        if (prior.conversationId !== id || prior.userMessage !== message) throw httpError(409, '发送标识已用于另一条消息');
        return { executionId: prior.id, taskId: session.taskId };
      }
      const snapshot = database.readSessionContext(tenantId, session.contextId);
      if (!snapshot) throw httpError(409, '继承上下文不可用');
      const first = !session.nativeId;
      if (first && session.deviceId !== 'local' && JSON.stringify(snapshot.entries).length > 100000) throw httpError(422, '远端上下文过长，暂无法在目标设备提供完整历史文件');
      const compiled = first ? await contextPrompt(snapshot, message, contextRoot) : { prompt: message, compacted: false };
      const job = database.mutateTaskCenter(tenantId, (current: any) => {
        const duplicate = current.executions?.find((j: any) => j.requestId === requestId);
        if (duplicate) {
          if (duplicate.conversationId !== id || duplicate.userMessage !== message) throw httpError(409, '发送标识已用于另一条消息');
          return { ...duplicate, replay: true };
        }
        const s = managed(id, current), task = current.tasks.find((t: any) => t.id === s.taskId);
        if (busy(current, task.id)) throw httpError(409, '请等待当前执行完成，结果未知时先核对原会话');
        if (s.nativeId !== session.nativeId) throw httpError(409, '会话已更新，请重试');
        const j = { id: randomUUID(), requestId, conversationId: id, sourceSessionId: s.sourceSessionId, contextId: s.contextId, contextDigest: snapshot.digest,
          contextCompacted: compiled.compacted, taskId: task.id, contextVersion: task.contextVersion, userMessage: message, prompt: compiled.prompt,
          agent: s.agent, agentLabel: s.agentLabel, deviceId: s.deviceId, cwd: s.cwd, projectId: s.projectId, appServerProjectId: s.appServerProjectId, protocol: s.protocol,
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
        for (const pending of read().sessions.filter((s: any) => s.source === 'conversation' && (s.status === 'preparing' || (s.status === 'ready' && s.pendingMessage)))) {
          if (busy(read(), pending.taskId)) continue;
          try {
            if (pending.status === 'ready') {
              await service.send(pending.id, { message: pending.pendingMessage, requestId: pending.pendingRequestId });
              continue;
            }
            const origin = await source(pending.sourceSessionId);
            if (closed) return;
            const task = read().tasks.find((t: any) => t.id === pending.taskId);
            const updated = freezeContext([{ role: 'reference', text: String(clean({ text: taskContent(task) })?.text || ''), source: `task:${task.id}` }, ...origin.entries.filter((e: ContextEntry) => e.source !== `task:${task.id}`)], origin.sources, origin.partial);
            const ready = database.mutateTaskCenter(tenantId, (data: any) => {
              const session = managed(pending.id, data);
              if (session.status !== 'preparing' || busy(data, session.taskId)) return false;
              database.saveSessionContext(tenantId, updated);
              session.contextId = updated.id; session.status = 'ready'; session.updatedAt = now();
              return true;
            });
            if (ready && pending.pendingMessage) await service.send(pending.id, { message: pending.pendingMessage, requestId: pending.pendingRequestId });
          } catch (error: any) {
            if (closed) return;
            database.mutateTaskCenter(tenantId, (data: any) => { const session = managed(pending.id, data); session.status = 'error'; session.preparationError = error.message; });
          }
        }
      } finally { preparing = false; }
    }
  };
  return service;
}
