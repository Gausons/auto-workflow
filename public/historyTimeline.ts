// Match by turn identity (or timestamp for older rollouts), never by text alone:
// users can legitimately send the same message in several different turns.
import type { Execution, HistoryMessage } from './taskTypes.js';

type PendingExecution = Pick<Execution, 'id' | 'prompt'> & {
  status: string;
  conversationId?: string;
  turnId?: string | null;
  output?: string;
  createdAt?: string;
};

export function pendingHistoryMessages(messages: HistoryMessage[], executions: PendingExecution[]): HistoryMessage[] {
  return executions.flatMap(job => {
    // A rejected submission is not a conversation message. Its error and retry
    // controls remain in the composer status.
    if (['failed', 'blocked', 'interrupted'].includes(job.status) && !job.turnId && !job.output) return [];
    const turnId = job.conversationId ? job.id : job.turnId;
    const start = messages.findIndex(m => m.role === 'user' && m.text === job.prompt &&
      (turnId && m.turnId ? m.turnId === turnId :
        Boolean(job.createdAt) && Number.isFinite(Date.parse(job.createdAt!)) && Date.parse(m.timestamp || '') >= Date.parse(job.createdAt!)));
    const end = start < 0 ? -1 : messages.findIndex((m, i) => i > start && m.role === 'user');
    const turn = start < 0 ? [] : messages.slice(start, end < 0 ? undefined : end);
    const outputSaved = job.output && turn.some(m => m.role === 'assistant' &&
      (m.text === job.output || m.text?.endsWith(job.output!)));
    return [
      ...(start < 0 ? [{ role: 'user', text: job.prompt }] : []),
      ...(job.output && !outputSaved ? [{ role: 'assistant', text: job.output }] : [])
    ];
  });
}
