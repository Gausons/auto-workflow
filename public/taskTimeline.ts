export const stamp = (value: any) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
export function taskActivity(task: any, data: any) {
  return Math.max(stamp(task.updatedAt), ...data.sessions.filter((s: any) => task.sessionIds.includes(s.id)).map((s: any) => stamp(s.updatedAt)), ...(data.executions || []).filter((j: any) => j.taskId === task.id).map((j: any) => stamp(j.updatedAt)));
}
export function taskTimeline(task: any, data: any) {
  const sessions = task.sessionIds.map((id: string) => data.sessions.find((s: any) => s.id === id) || { id, title: '会话来源暂不可用', missing: true });
  const jobs = (data.executions || []).filter((j: any) => j.taskId === task.id);
  const items: any[] = sessions.map((s: any) => ({ kind: 'session', id: s.id, at: s.createdAt || s.updatedAt, value: s, jobs: jobs.filter((j: any) => s.deviceId === j.deviceId && s.agent === (j.agent || 'codex') && s.nativeId === (j.sessionId || j.threadId)) }));
  const linkedJobs = new Set(items.flatMap(i => i.jobs.map((j: any) => j.id)));
  items.push(...jobs.filter((j: any) => !linkedJobs.has(j.id)).map((j: any) => ({ kind: 'execution', id: j.id, at: j.createdAt, value: j })));
  items.push(...data.handoffs.filter((h: any) => h.taskId === task.id || h.destinationTaskId === task.id).map((h: any) => ({ kind: 'handoff', id: h.id, at: h.createdAt, value: h })));
  // Audit events are stored separately; the reading timeline focuses on conversations and outcomes.
  return items.sort((a, b) => stamp(a.at) - stamp(b.at) || a.id.localeCompare(b.id));
}
