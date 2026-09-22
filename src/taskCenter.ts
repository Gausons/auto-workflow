import { createHash, randomUUID } from 'node:crypto';
import { taskContent, taskTitle } from '../public/taskContent.js';
import { hostname } from 'node:os';
import { httpError } from './rbac.js';
import type { Actor, AgentProject, Device, Handoff, HandoffMode, HandoffStatus, Session, Task, TaskCenterData, TaskContext, TaskStatus } from '../public/taskTypes.js';

const statuses: TaskStatus[] = ['waiting', 'error', 'running', 'ready', 'review', 'completed'];
const contextKeys: Array<keyof TaskContext> = ['goal', 'constraints', 'decisions', 'next', 'files'];
type InputRecord = Record<string, unknown>;
interface TaskCenterDatabase {
  readTaskCenter(tenantId: string): TaskCenterData;
  mutateTaskCenter<T>(tenantId: string, update: (data: TaskCenterData) => T): T;
}
interface HistoryCatalog {
  providers: Array<{ id: string }>;
  sessions: Array<Partial<Session> & Pick<Session, 'id' | 'agent' | 'title' | 'cwd' | 'updatedAt'>>;
}
interface TaskCenterHistory { catalog(): Promise<HistoryCatalog> }
interface TaskCommand extends InputRecord {
  action?: string;
  taskId?: string;
  revision?: number;
  title?: unknown;
  content?: unknown;
  context?: InputRecord;
  status?: string;
  sessionId?: string;
  targetTaskId?: string;
  targetRevision?: number;
  deviceId?: unknown;
  name?: unknown;
  agents?: unknown;
  codexProjects?: unknown;
  sessions?: unknown;
  mode?: string;
  agent?: unknown;
  targetSessionId?: string;
  instruction?: unknown;
  includeFiles?: boolean;
  includeSources?: boolean;
  handoffId?: string;
  note?: unknown;
  source?: InputRecord;
}
interface LocalCatalog { device: Device; sessions: Session[] }

const isRecord = (value: unknown): value is InputRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 12000) => {
  if (typeof value !== 'string' || value.length > max) throw httpError(400, `文本格式无效或超过 ${max} 字符`);
  return value.trim();
};
const required = (value: unknown, max = 12000) => { const s = text(value, max); if (!s) throw httpError(400, '请填写必填内容'); return s; };
const find = <T extends { id: string }>(items: T[], id: unknown): T => { const item = items.find(v => v.id === id); if (!item) throw httpError(404, '记录不存在'); return item; };
const now = () => new Date().toISOString();
const sessionKey = (device: string, id: string) => createHash('sha256').update(`${device}\0${id}`).digest('hex');
const online = (device: Device) => device.id === 'local' || Date.now() - Date.parse(device.lastSeen) < 90000;
const event = (task: Task, message: string) => { task.events.unshift({ id: randomUUID(), at: now(), message }); task.updatedAt = now(); task.events = task.events.slice(0, 200); };
const taskContext = (value: InputRecord | Partial<TaskContext> = {}, title = ''): TaskContext => {
  const record = value as InputRecord;
  return Object.fromEntries(contextKeys.map(key => [key, text(record[key] ?? (key === 'goal' ? title : ''))])) as unknown as TaskContext;
};
const inputRecord = (value: unknown): InputRecord => isRecord(value) ? value : {};

export function createTaskCenter({ database, tenantId, history }: { database: TaskCenterDatabase; tenantId: string; history: TaskCenterHistory }) {
  async function catalog(): Promise<LocalCatalog> {
    const result = await history.catalog();
    return {
      device: { id: 'local', name: hostname(), agents: result.providers.map(p => p.id), lastSeen: now(), transport: 'manual' },
      sessions: result.sessions.map(s => ({ ...s, deviceId: 'local', nativeId: s.sessionId || s.id, historyId: s.id, excerpt: '' }))
    };
  }
  function snapshot(local: LocalCatalog): TaskCenterData {
    const data = database.readTaskCenter(tenantId);
    const synthetic = new Set(data.sessions.filter(s => ['codexExecution', 'agentExecution', 'conversation'].includes(s.source || '')).map(s => `${s.deviceId}:${s.nativeId}`));
    const sessions = [...local.sessions.filter(s => !synthetic.has(`local:${s.nativeId}`)), ...data.sessions.filter(s => ['codexExecution', 'agentExecution', 'conversation'].includes(s.source || '') || !synthetic.has(`${s.deviceId}:${s.nativeId}`)).map(s => ['codexExecution', 'agentExecution', 'conversation'].includes(s.source || '') && s.source !== 'conversation' && s.deviceId === 'local' ? { ...s, historyId: local.sessions.find(l => l.nativeId === s.nativeId)?.historyId } : s)];
    return { ...data, devices: [local.device, ...data.devices].map(d => ({ ...d, online: online(d) })),
      sessions, tasks: data.tasks.map(task => ({ ...task, content: taskContent(task) })).sort((a, b) => statuses.indexOf(a.status) - statuses.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt)) };
  }
  async function command(rawInput: unknown, actor: Actor) {
    if (!isRecord(rawInput)) throw httpError(400, '请求必须是对象');
    const input = rawInput as TaskCommand;
    if (input.context !== undefined && (!input.context || typeof input.context !== 'object' || Array.isArray(input.context))) throw httpError(400, '上下文格式无效');
    const local = await catalog();
    return database.mutateTaskCenter(tenantId, data => {
      const allSessions = [...local.sessions, ...data.sessions];
      const allDevices = [local.device, ...data.devices];
      const taskFor = () => find(data.tasks, input.taskId);
      const editable = (task: Task) => { if (input.revision !== task.revision) throw httpError(409, '任务已在其他位置更新，请刷新后重试'); };
      const saveTask = (titleValue: unknown, context: InputRecord | Partial<TaskContext> = {}, contentValue?: unknown) => {
        let title = titleValue, content = contentValue === undefined ? undefined : required(contentValue, 64000);
        if (content !== undefined) title = taskTitle(content);
        const normalizedTitle = required(title, 120);
        const task: Task = { id: randomUUID(), title: normalizedTitle, status: 'ready', revision: 1, contextVersion: 1,
          context: taskContext(context, normalizedTitle),
          sessionIds: [], events: [], createdAt: now(), updatedAt: now() };
        if (content !== undefined) { task.content = content; delete task.context; }
        if (input.source?.type === 'defect') task.source = { type: 'defect', id: required(input.source.id, 250), code: text(input.source.code ?? '', 120) };
        event(task, '创建任务'); data.tasks.push(task); return task;
      };
      const attach = (task: Task, id: unknown) => {
        const session = find(allSessions, id);
        if (data.tasks.some(t => t.id !== task.id && t.sessionIds.includes(session.id))) throw httpError(409, '会话已归属其他任务，请使用引用信息');
        if (!task.sessionIds.includes(session.id)) { task.sessionIds.push(session.id); event(task, `关联会话：${session.title}`); }
        return session;
      };
      switch (input.action) {
        case 'create': {
          const task = saveTask(input.title, input.context, input.content);
          if (input.sessionId) attach(task, input.sessionId);
          return { taskId: task.id, revision: task.revision };
        }
        case 'update': {
          const task = taskFor(); editable(task);
          if (data.executions?.some(j => j.taskId === task.id && ['queued', 'launching', 'running', 'waiting', 'unknown'].includes(j.status))) throw httpError(409, 'Agent 正在执行或结果待核对，请先处理执行记录');
          const previousContent = taskContent(task);
          const content = input.content !== undefined ? required(input.content, 64000) : undefined;
          task.title = content !== undefined ? taskTitle(content) : required(input.title ?? task.title, 120);
          if (!statuses.includes(input.status as TaskStatus)) throw httpError(400, '任务状态无效');
          if (data.handoffs.some(h => h.taskId === task.id && h.mode === 'continue' && ['pending', 'received'].includes(h.status))) throw httpError(409, '请先完成或取消当前交接，再修改任务');
          if (content !== undefined) {
            if (content !== previousContent) task.contextVersion++;
            task.content = content; delete task.context;
          } else if (input.context !== undefined) {
            const context = taskContext(input.context);
            if (JSON.stringify(context) !== JSON.stringify(task.context)) { task.context = context; delete task.content; task.contextVersion++; }
          }
          task.status = input.status as TaskStatus; task.revision++; event(task, `${input.status === 'completed' ? '用户标记任务完成' : '更新任务'} · 上下文 v${task.contextVersion}`); return { taskId: task.id };
        }
        case 'link': {
          const task = taskFor(); editable(task); attach(task, input.sessionId); task.revision++; return { taskId: task.id };
        }
        case 'unlink':
        case 'move': {
          const task = taskFor(); editable(task);
          const sessionId = required(input.sessionId, 250);
          if (!task.sessionIds.includes(sessionId)) throw httpError(404, '会话不属于此任务');
          const busy = (id: string) => data.executions?.some(j => j.taskId === id && ['queued', 'launching', 'running', 'waiting', 'unknown'].includes(j.status)) || data.handoffs.some(h => (h.taskId === id || h.destinationTaskId === id) && ['pending', 'received'].includes(h.status));
          if (busy(task.id)) throw httpError(409, '请先处理当前执行或交接，再调整归属');
          let target: Task | undefined;
          if (input.action === 'move') {
            target = find(data.tasks, input.targetTaskId);
            if (target.id === task.id) throw httpError(400, '请选择其他任务');
            if (target.revision !== input.targetRevision || busy(target.id)) throw httpError(409, '目标任务已更新或正在执行，请刷新后重试');
          }
          const session = allSessions.find(s => s.id === sessionId);
          if (session?.source === 'conversation') {
            if (!target) throw httpError(409, '工作台新会话需要保留任务归属，请移动到其他任务');
            session.taskId = target.id;
            for (const job of data.executions || []) if (job.conversationId === session.id) job.taskId = target.id;
          }
          task.sessionIds = task.sessionIds.filter(id => id !== sessionId);
          task.revision++; event(task, `解除会话关联：${session?.title || sessionId}`);
          if (target) { target.sessionIds.push(sessionId); target.revision++; event(target, `从任务「${task.title}」移入会话：${session?.title || sessionId}`); }
          return { taskId: target?.id || task.id };
        }
        case 'heartbeat': {
          const id = required(input.deviceId, 80);
          if (!/^[a-zA-Z0-9_-]+$/.test(id) || id === 'local') throw httpError(400, '设备标识无效');
          let device = data.devices.find(d => d.id === id);
          if (device && device.owner !== actor.id) throw httpError(403, '设备属于其他成员');
          if (!Array.isArray(input.agents) || input.agents.length > 20) throw httpError(400, 'Agent 列表无效');
          const devicePatch: Device = { id, owner: actor.id, name: required(input.name, 120), agents: input.agents.map(agent => required(agent, 80)), lastSeen: now(), transport: 'connector' };
          if (!device) { device = devicePatch; data.devices.push(device); } else Object.assign(device, devicePatch);
          if (input.codexProjects !== undefined) {
            if (!Array.isArray(input.codexProjects) || input.codexProjects.length > 100) throw httpError(400, 'Codex 项目列表无效');
            device.codexProjects = input.codexProjects.map(value => { const p = inputRecord(value); return ({
              id: required(p?.id, 100), name: required(p?.name, 120), cwd: required(p?.cwd, 2000), protocol: p?.protocol === 'acp' ? 'acp' : 'legacy', agent: text(p?.agent ?? 'codex', 80) || 'codex', appServerProjectId: p?.appServerProjectId === null ? null : text(p?.appServerProjectId ?? '', 100) || undefined,
              models: Array.isArray(p?.models) ? p.models.slice(0, 30).map(value => { const model = inputRecord(value); return ({ id: required(model?.id, 120), name: required(model?.name || model?.id, 120), description: text(model?.description || '', 500), defaultReasoningEffort: text(model?.defaultReasoningEffort || '', 40), reasoningEfforts: Array.isArray(model?.reasoningEfforts) ? model.reasoningEfforts.slice(0, 10).map(value => { const effort = inputRecord(value); return ({ id: required(effort?.id, 40), name: required(effort?.name || effort?.id, 80), description: text(effort?.description || '', 500) }); }) : [] }); }) : [],
              defaultModel: text(p?.defaultModel || '', 120), defaultReasoningEffort: text(p?.defaultReasoningEffort || '', 40),
              reasoningEfforts: Array.isArray(p?.reasoningEfforts) ? p.reasoningEfforts.slice(0, 10).map(value => { const effort = inputRecord(value); return ({ id: required(effort?.id, 40), name: required(effort?.name || effort?.id, 80), description: text(effort?.description || '', 500) }); }) : []
            }); });
          }
          if (!Array.isArray(input.sessions) || input.sessions.length > 100) throw httpError(400, '每批最多同步 100 个会话');
          for (const value of input.sessions) {
            if (!isRecord(value)) throw httpError(400, '会话格式无效');
            const s = value;
            const nativeId = required(s.nativeId, 250), agent = required(s.agent, 80);
            if (!device.agents.includes(agent)) throw httpError(400, '会话 Agent 不属于设备');
            const id = sessionKey(device.id, `${agent}:${nativeId}`);
            const createdAt = typeof s.createdAt === 'string' && Number.isFinite(Date.parse(s.createdAt)) ? new Date(s.createdAt).toISOString() : undefined;
            const updatedAt = typeof s.updatedAt === 'string' && Number.isFinite(Date.parse(s.updatedAt)) ? new Date(s.updatedAt).toISOString() : now();
            const item: Session = { id, nativeId, deviceId: device.id, agent, agentLabel: agent, title: required(s.title, 120), cwd: text(s.cwd ?? '', 2000), createdAt,
              status: text(s.status ?? 'unknown', 80), updatedAt,
              excerpt: text(s.excerpt ?? '', 24000), partial: true };
            const old = data.sessions.findIndex(session => session.id === id);
            if (old < 0) data.sessions.push(item); else data.sessions[old] = item;
          }
          return { deviceId: id };
        }
        case 'handoff': {
          const task = taskFor(); editable(task);
          if (!['continue', 'branch', 'reference'].includes(input.mode || '')) throw httpError(400, '交接方式无效');
          const mode = input.mode as HandoffMode;
          const device = find(allDevices, input.deviceId), agent = required(input.agent, 80);
          if (!device.agents.includes(agent)) throw httpError(400, '目标 Agent 不存在');
          if (input.mode === 'continue' && task.status === 'running') throw httpError(409, '请先在原 Agent 停止或完成当前步骤，再将任务设为待接续');
          if (input.mode === 'continue' && data.handoffs.some(h => h.taskId === task.id && h.mode === 'continue' && ['pending', 'received'].includes(h.status))) throw httpError(409, '已有待完成的接续，请先处理或取消');
          let targetSessionId: string | null = null;
          if (input.mode === 'reference') {
            const target = find(allSessions, input.targetSessionId);
            if (target.deviceId !== device.id || target.agent !== agent) throw httpError(400, '请选择目标位置上的会话');
            targetSessionId = target.id;
          }
          const instruction = required(input.instruction);
          let destination = task;
          if (input.mode === 'branch') { destination = saveTask(`${task.title.slice(0, 110)} · 分支`, task.context, typeof task.content === 'string' ? task.content : undefined); destination.parentTaskId = task.id; }
          const context: TaskContext = task.context ? { ...task.context } : taskContext({}, task.title);
          if (!input.includeFiles) context.files = '';
          const sources = input.includeSources ? task.sessionIds.map(id => allSessions.find(session => session.id === id)).filter((session): session is Session => Boolean(session)).map(session => ({ id: session.id, title: session.title, deviceId: session.deviceId, agent: session.agent, nativeId: session.nativeId, cwd: session.cwd, excerpt: session.excerpt, updatedAt: session.updatedAt })) : [];
          const h: Handoff = { id: randomUUID(), taskId: task.id, destinationTaskId: destination.id, mode, deviceId: device.id, agent,
            targetSessionId, sourceSessionId: task.sessionIds.at(-1) || null, status: 'pending', createdAt: now(), updatedAt: now(), sourceRevision: task.revision,
            packet: { title: task.title, contextVersion: task.contextVersion, content: typeof task.content === 'string' ? task.content : taskContent({ ...task, context }), context, instruction,
              sources,
              limitations: '传递任务摘要和已同步片段；不自动复制文件、不恢复 Agent 内部状态、不自动执行指令。请核对工作目录、文件版本及权限。' } };
          data.handoffs.push(h); task.revision++; event(task, `准备${({ continue: '接续', branch: '分支', reference: '引用' } as Record<string, string>)[h.mode]} → ${device.name} / ${agent}`);
          return { taskId: destination.id, handoffId: h.id };
        }
        case 'ack': {
          const h = find(data.handoffs, input.handoffId), task = find(data.tasks, h.destinationTaskId);
          if (!['received', 'started', 'cancelled', 'failed'].includes(input.status || '')) throw httpError(400, '交接状态无效');
          if (h.status === input.status) return { handoffId: h.id };
          if (['started', 'cancelled', 'failed'].includes(h.status)) throw httpError(409, '交接已结束');
          if (input.status === 'started' && (h.status !== 'received' || h.mode === 'reference')) throw httpError(409, '请先确认接收，引用信息不改变执行状态');
          if (input.status === 'received' && h.status !== 'pending') throw httpError(409, '交接状态已变化');
          if (input.status === 'started') {
            const session = find(allSessions, input.sessionId);
            if (session.deviceId !== h.deviceId || session.agent !== h.agent) throw httpError(400, '请选择目标设备和 Agent 上的新会话');
            if (task.sessionIds.includes(session.id)) throw httpError(409, '请选择新接续会话，不能使用已关联的原会话');
            attach(task, session.id); h.sessionId = session.id; task.status = 'running';
          }
          h.status = input.status as HandoffStatus; h.updatedAt = now(); h.note = text(input.note ?? '', 2000);
          task.revision++;
          const message = h.mode === 'reference' && h.status === 'received' ? '引用信息已接收' : ({ received: '上下文已接收，等待执行', started: '目标会话已开始执行', cancelled: '交接已取消', failed: '交接失败' } as Record<string, string>)[h.status];
          event(task, `${message}${h.note ? '：' + h.note : ''}`);
          return { handoffId: h.id };
        }
        default: throw httpError(400, '不支持的操作');
      }
    });
  }
  return { snapshot: async () => snapshot(await catalog()), command };
}
