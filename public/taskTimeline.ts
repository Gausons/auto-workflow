import type { Execution, Handoff, Session, Task, TaskCenterData } from './taskTypes.js';

type TimelineTask = Pick<Task, 'id' | 'sessionIds'> & { updatedAt?: string; events?: Array<{ id: string; at?: string; message: string }> };
type TimelineSession = Pick<Session, 'id'> & Partial<Session>;
type TimelineExecution = Pick<Execution, 'id' | 'taskId'> & Partial<Omit<Execution, 'id' | 'taskId' | 'status'>> & { status?: string };
type TimelineHandoff = Pick<Handoff, 'id' | 'taskId'> & Partial<Omit<Handoff, 'id' | 'taskId' | 'status'>> & { status?: string };
type TimelineData = {
  sessions: TimelineSession[];
  executions: TimelineExecution[];
  handoffs: TimelineHandoff[];
};

export const stamp = (value?: string) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
export function taskActivity(task: TimelineTask, data: TimelineData) {
  return Math.max(stamp(task.updatedAt), ...data.sessions.filter(s => task.sessionIds.includes(s.id)).map(s => stamp(s.updatedAt)), ...data.executions.filter(j => j.taskId === task.id).map(j => stamp(j.updatedAt)));
}
export type TimelineItem =
  | { kind: 'session'; id: string; at?: string; value: TimelineSession; jobs: TimelineExecution[] }
  | { kind: 'execution'; id: string; at?: string; value: TimelineExecution }
  | { kind: 'handoff'; id: string; at?: string; value: TimelineHandoff };

export function taskTimeline(task: TimelineTask, data: TimelineData): TimelineItem[] {
  const sessions: TimelineSession[] = task.sessionIds.map(id => data.sessions.find(s => s.id === id) || { id, title: '会话来源暂不可用', missing: true });
  const jobs = data.executions.filter(j => j.taskId === task.id);
  const items: TimelineItem[] = sessions.map(s => ({ kind: 'session', id: s.id, at: s.createdAt || s.updatedAt, value: s, jobs: jobs.filter(j => j.conversationId ? j.conversationId === s.id : Boolean(s.nativeId) && s.deviceId === j.deviceId && s.agent === (j.agent || 'codex') && s.nativeId === (j.sessionId || j.threadId)) }));
  const linkedJobs = new Set(items.flatMap(item => item.kind === 'session' ? item.jobs.map(job => job.id) : []));
  items.push(...jobs.filter(job => !linkedJobs.has(job.id)).map(job => ({ kind: 'execution' as const, id: job.id, at: job.createdAt, value: job })));
  items.push(...data.handoffs.filter(handoff => handoff.taskId === task.id || handoff.destinationTaskId === task.id).map(handoff => ({ kind: 'handoff' as const, id: handoff.id, at: handoff.createdAt, value: handoff })));
  // Audit events are stored separately; the reading timeline focuses on conversations and outcomes.
  return items.sort((a, b) => stamp(a.at) - stamp(b.at) || a.id.localeCompare(b.id));
}
