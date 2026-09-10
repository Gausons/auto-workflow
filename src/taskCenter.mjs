import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { httpError } from './rbac.mjs';

const statuses = ['waiting', 'error', 'running', 'ready', 'completed'];
const text = (value, max = 12000) => {
  if (typeof value !== 'string' || value.length > max) throw httpError(400, `文本格式无效或超过 ${max} 字符`);
  return value.trim();
};
const required = (value, max) => { const s = text(value, max); if (!s) throw httpError(400, '请填写必填内容'); return s; };
const find = (items, id) => { const item = items.find(v => v.id === id); if (!item) throw httpError(404, '记录不存在'); return item; };
const now = () => new Date().toISOString();
const sessionKey = (device, id) => createHash('sha256').update(`${device}\0${id}`).digest('hex');
const online = (device) => device.id === 'local' || Date.now() - Date.parse(device.lastSeen) < 90000;
const event = (task, message) => { task.events.unshift({ id: randomUUID(), at: now(), message }); task.updatedAt = now(); task.events = task.events.slice(0, 200); };

export function createTaskCenter({ database, tenantId, history }) {
  async function catalog() {
    const result = await history.catalog();
    return {
      device: { id: 'local', name: hostname(), agents: result.providers.map(p => p.id), lastSeen: now(), transport: 'manual' },
      sessions: result.sessions.map(s => ({ ...s, deviceId: 'local', nativeId: s.sessionId || s.id, historyId: s.id, excerpt: '' }))
    };
  }
  function snapshot(local) {
    const data = database.readTaskCenter(tenantId);
    const synthetic = new Set(data.sessions.filter(s => s.source === 'codexExecution' && s.deviceId === 'local').map(s => s.nativeId));
    const sessions = [...local.sessions.filter(s => !synthetic.has(s.nativeId)), ...data.sessions.map(s => s.source === 'codexExecution' ? { ...s, historyId: local.sessions.find(l => l.nativeId === s.nativeId)?.historyId } : s)];
    return { ...data, devices: [local.device, ...data.devices].map(d => ({ ...d, online: online(d) })),
      sessions, tasks: data.tasks.sort((a, b) => statuses.indexOf(a.status) - statuses.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt)) };
  }
  async function command(input, actor) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, '请求必须是对象');
    if (input.context !== undefined && (!input.context || typeof input.context !== 'object' || Array.isArray(input.context))) throw httpError(400, '上下文格式无效');
    const local = await catalog();
    return database.mutateTaskCenter(tenantId, data => {
      const allSessions = [...local.sessions, ...data.sessions];
      const allDevices = [local.device, ...data.devices];
      const taskFor = () => find(data.tasks, input.taskId);
      const editable = task => { if (input.revision !== task.revision) throw httpError(409, '任务已在其他位置更新，请刷新后重试'); };
      const saveTask = (title, context = {}) => {
        const task = { id: randomUUID(), title: required(title, 120), status: 'ready', revision: 1, contextVersion: 1,
          context: Object.fromEntries(['goal', 'constraints', 'decisions', 'next', 'files'].map(k => [k, text(context[k] ?? (k === 'goal' ? title : ''))])),
          sessionIds: [], events: [], createdAt: now(), updatedAt: now() };
        event(task, '创建任务'); data.tasks.push(task); return task;
      };
      const attach = (task, id) => {
        const session = find(allSessions, id);
        if (data.tasks.some(t => t.id !== task.id && t.sessionIds.includes(id))) throw httpError(409, '会话已归属其他任务，请使用引用信息');
        if (!task.sessionIds.includes(id)) { task.sessionIds.push(id); event(task, `关联会话：${session.title}`); }
        return session;
      };
      switch (input.action) {
        case 'create': {
          const task = saveTask(input.title, input.context);
          if (input.sessionId) attach(task, input.sessionId);
          return { taskId: task.id };
        }
        case 'update': {
          const task = taskFor(); editable(task);
          if (data.executions?.some(j => j.taskId === task.id && ['queued', 'launching', 'running', 'waiting', 'unknown'].includes(j.status))) throw httpError(409, 'Codex 正在执行或结果待核对，请先处理执行记录');
          task.title = required(input.title, 120);
          if (!statuses.includes(input.status)) throw httpError(400, '任务状态无效');
          if (data.handoffs.some(h => h.taskId === task.id && h.mode === 'continue' && ['pending', 'received'].includes(h.status))) throw httpError(409, '请先完成或取消当前交接，再修改任务');
          const context = Object.fromEntries(['goal', 'constraints', 'decisions', 'next', 'files'].map(k => [k, text(input.context?.[k] ?? '')]));
          if (JSON.stringify(context) !== JSON.stringify(task.context)) { task.context = context; task.contextVersion++; }
          task.status = input.status; task.revision++; event(task, `更新任务 · 上下文 v${task.contextVersion}`); return { taskId: task.id };
        }
        case 'link': {
          const task = taskFor(); editable(task); attach(task, input.sessionId); task.revision++; return { taskId: task.id };
        }
        case 'heartbeat': {
          const id = required(input.deviceId, 80);
          if (!/^[a-zA-Z0-9_-]+$/.test(id) || id === 'local') throw httpError(400, '设备标识无效');
          let device = data.devices.find(d => d.id === id);
          if (device && device.owner !== actor.id) throw httpError(403, '设备属于其他成员');
          if (!device) { device = { id, owner: actor.id }; data.devices.push(device); }
          if (!Array.isArray(input.agents) || input.agents.length > 20) throw httpError(400, 'Agent 列表无效');
          Object.assign(device, { name: required(input.name, 120), agents: input.agents.map(a => required(a, 80)), lastSeen: now(), transport: 'connector' });
          if (input.codexProjects !== undefined) {
            if (!Array.isArray(input.codexProjects) || input.codexProjects.length > 100) throw httpError(400, 'Codex 项目列表无效');
            device.codexProjects = input.codexProjects.map(p => ({ id: required(p?.id, 100), name: required(p?.name, 120), cwd: required(p?.cwd, 2000) }));
          }
          if (!Array.isArray(input.sessions) || input.sessions.length > 100) throw httpError(400, '每批最多同步 100 个会话');
          for (const s of input.sessions) {
            if (!s || typeof s !== 'object' || Array.isArray(s)) throw httpError(400, '会话格式无效');
            const nativeId = required(s.nativeId, 250), agent = required(s.agent, 80);
            if (!device.agents.includes(agent)) throw httpError(400, '会话 Agent 不属于设备');
            const id = sessionKey(device.id, `${agent}:${nativeId}`);
            const item = { id, nativeId, deviceId: device.id, agent, agentLabel: agent, title: required(s.title, 120), cwd: text(s.cwd ?? '', 2000),
              status: text(s.status ?? 'unknown', 80), updatedAt: Number.isFinite(Date.parse(s.updatedAt)) ? new Date(s.updatedAt).toISOString() : now(),
              excerpt: text(s.excerpt ?? '', 24000), partial: true };
            const old = data.sessions.findIndex(s => s.id === id);
            if (old < 0) data.sessions.push(item); else data.sessions[old] = item;
          }
          return { deviceId: id };
        }
        case 'handoff': {
          const task = taskFor(); editable(task);
          if (!['continue', 'branch', 'reference'].includes(input.mode)) throw httpError(400, '交接方式无效');
          const device = find(allDevices, input.deviceId), agent = required(input.agent, 80);
          if (!device.agents.includes(agent)) throw httpError(400, '目标 Agent 不存在');
          if (input.mode === 'continue' && task.status === 'running') throw httpError(409, '请先在原 Agent 停止或完成当前步骤，再将任务设为待接续');
          if (input.mode === 'continue' && data.handoffs.some(h => h.taskId === task.id && h.mode === 'continue' && ['pending', 'received'].includes(h.status))) throw httpError(409, '已有待完成的接续，请先处理或取消');
          let targetSessionId = null;
          if (input.mode === 'reference') {
            const target = find(allSessions, input.targetSessionId);
            if (target.deviceId !== device.id || target.agent !== agent) throw httpError(400, '请选择目标位置上的会话');
            targetSessionId = target.id;
          }
          const instruction = required(input.instruction);
          let destination = task;
          if (input.mode === 'branch') { destination = saveTask(`${task.title.slice(0, 110)} · 分支`, task.context); destination.parentTaskId = task.id; }
          const context = { ...task.context };
          if (!input.includeFiles) context.files = '';
          const h = { id: randomUUID(), taskId: task.id, destinationTaskId: destination.id, mode: input.mode, deviceId: device.id, agent,
            targetSessionId, sourceSessionId: task.sessionIds.at(-1) || null, status: 'pending', createdAt: now(), updatedAt: now(), sourceRevision: task.revision,
            packet: { title: task.title, contextVersion: task.contextVersion, context, instruction,
              sources: input.includeSources ? task.sessionIds.map(id => allSessions.find(s => s.id === id)).filter(Boolean).map(s => ({ id: s.id, title: s.title, deviceId: s.deviceId, agent: s.agent, nativeId: s.nativeId, cwd: s.cwd, excerpt: s.excerpt, updatedAt: s.updatedAt })) : [],
              limitations: '传递任务摘要和已同步片段；不自动复制文件、不恢复 Agent 内部状态、不自动执行指令。请核对工作目录、文件版本及权限。' } };
          data.handoffs.push(h); task.revision++; event(task, `准备${{ continue: '接续', branch: '分支', reference: '引用' }[h.mode]} → ${device.name} / ${agent}`);
          return { taskId: destination.id, handoffId: h.id };
        }
        case 'ack': {
          const h = find(data.handoffs, input.handoffId), task = find(data.tasks, h.destinationTaskId);
          if (!['received', 'started', 'cancelled', 'failed'].includes(input.status)) throw httpError(400, '交接状态无效');
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
          h.status = input.status; h.updatedAt = now(); h.note = text(input.note ?? '', 2000);
          task.revision++;
          const message = h.mode === 'reference' && h.status === 'received' ? '引用信息已接收' : { received: '上下文已接收，等待执行', started: '目标会话已开始执行', cancelled: '交接已取消', failed: '交接失败' }[h.status];
          event(task, `${message}${h.note ? '：' + h.note : ''}`);
          return { handoffId: h.id };
        }
        default: throw httpError(400, '不支持的操作');
      }
    });
  }
  return { snapshot: async () => snapshot(await catalog()), command };
}
