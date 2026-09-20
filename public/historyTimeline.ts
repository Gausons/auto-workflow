// Match by turn identity (or timestamp for older rollouts), never by text alone:
// users can legitimately send the same message in several different turns.
export function pendingHistoryMessages(messages: any[], executions: any[]) {
  return executions.flatMap(job => {
    // A rejected submission is not a conversation message. Its error and retry
    // controls remain in the composer status.
    if (['failed', 'blocked', 'interrupted'].includes(job.status) && !job.turnId && !job.output) return [];
    const start = messages.findIndex(m => m.role === 'user' && m.text === job.prompt &&
      (job.turnId && m.turnId ? m.turnId === job.turnId :
        Number.isFinite(Date.parse(job.createdAt)) && Date.parse(m.timestamp) >= Date.parse(job.createdAt)));
    const end = start < 0 ? -1 : messages.findIndex((m, i) => i > start && m.role === 'user');
    const turn = start < 0 ? [] : messages.slice(start, end < 0 ? undefined : end);
    const outputSaved = job.output && turn.some(m => m.role === 'assistant' &&
      (m.text === job.output || m.text?.endsWith(job.output)));
    return [
      ...(start < 0 ? [{ role: 'user', text: job.prompt }] : []),
      ...(job.output && !outputSaved ? [{ role: 'assistant', text: job.output }] : [])
    ];
  });
}
