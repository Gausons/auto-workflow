import type { TaskCenterData } from '../../../shared/taskTypes.js';

export interface CompletionNotice {
  id: string;
  heading: string;
  title: string;
  taskId?: string;
  sessionId?: string;
}
const active = new Set(['queued', 'launching', 'running', 'waiting', 'unknown']);

/** Browser-workspace observer: baseline historical completions, then report each new completion once. */
export function createCompletionTracker() {
  let previous: TaskCenterData | undefined;
  let baselineAt = 0;
  const completedExecutions = new Set<string>();
  const delivered = new Set<string>();
  return (next: TaskCenterData): CompletionNotice[] => {
    const before = previous;
    previous = next;
    if (!before) {
      baselineAt = Date.now();
      for (const execution of next.executions || []) if (execution.status === 'completed') completedExecutions.add(execution.id);
      for (const task of next.tasks) if (task.status === 'completed') delivered.add(`task:${task.id}:${task.revision}`);
      for (const session of next.sessions) if (session.status === 'completed') delivered.add(`session:${session.id}:${session.updatedAt}`);
      return [];
    }
    const notices: CompletionNotice[] = [];
    const finishedTasks = new Set<string>();
    const tasksBefore = new Map(before.tasks.map(task => [task.id, task]));
    for (const task of next.tasks) if (task.status === 'completed' && tasksBefore.has(task.id) && tasksBefore.get(task.id)?.status !== 'completed') {
      finishedTasks.add(task.id);
      notices.push({ id: `task:${task.id}:${task.revision}`, heading: '任务已完成', title: task.title, taskId: task.id });
    }
    const executionsBefore = new Map((before.executions || []).map(execution => [execution.id, execution]));
    const completedSessions = new Set<string>();
    for (const execution of next.executions || []) {
      if (execution.status !== 'completed' || completedExecutions.has(execution.id)) continue;
      completedExecutions.add(execution.id);
      const old = executionsBefore.get(execution.id);
      // Also catch very short executions created and completed between two updates.
      if (!old && !(Date.parse(execution.createdAt) >= baselineAt)) continue;
      const sessionId = execution.conversationId || execution.historySessionId;
      if (sessionId) completedSessions.add(sessionId);
      if (finishedTasks.has(execution.taskId)) continue;
      const task = next.tasks.find(item => item.id === execution.taskId);
      const session = next.sessions.find(item => item.id === sessionId);
      notices.push({ id: `execution:${execution.id}`, heading: sessionId ? '会话本轮已完成' : '任务本轮执行完成', title: session?.title || task?.title || execution.title || 'Agent 执行', ...(sessionId ? { sessionId } : { taskId: execution.taskId }) });
    }
    const sessionsBefore = new Map(before.sessions.map(session => [session.id, session]));
    for (const session of next.sessions) {
      if (session.source === 'agentExecution' || session.source === 'conversation') continue;
      const old = sessionsBefore.get(session.id);
      if (session.status !== 'completed' || !old || !active.has(old.status || '') || completedSessions.has(session.id) || (session.taskId && finishedTasks.has(session.taskId))) continue;
      // Managed execution and session status can arrive separately; the execution is authoritative.
      const tracked = (next.executions || []).some(execution =>
        (execution.conversationId === session.id || execution.historySessionId === session.id) &&
        (active.has(execution.status) || Date.parse(execution.updatedAt) >= Date.parse(old.updatedAt)));
      if (tracked) continue;
      notices.push({ id: `session:${session.id}:${session.updatedAt}`, heading: '会话本轮已完成', title: session.title, sessionId: session.id });
    }
    return notices.filter(notice => { if (delivered.has(notice.id)) return false; delivered.add(notice.id); return true; });
  };
}
