import type { HistoryMessage } from './taskTypes.js';

// A question starts a turn; all progress, tool records and replies belong to
// it until the next question. Keep an unfinished latest turn visible as well.
export function historyTurnStarts(messages: HistoryMessage[]): number[] {
  const starts = messages.flatMap((message, index) => message.role === 'user' ? [index] : []);
  return starts.length ? (starts[0] === 0 ? starts : [0, ...starts]) : messages.length ? [0] : [];
}

export function historyTurnPage<T extends HistoryMessage>(messages: T[], before = messages.length, limit = 10) {
  const starts = historyTurnStarts(messages);
  const end = starts.findIndex(start => start >= before);
  const endTurn = end < 0 ? starts.length : end;
  const startTurn = Math.max(0, endTurn - limit);
  const offset = starts[startTurn] ?? 0;
  const boundary = starts[endTurn] ?? messages.length;
  return { messages: messages.slice(offset, boundary), total: messages.length, offset,
    turnPage: { total: starts.length, count: endTurn - startTurn, before: startTurn > 0 ? offset : null } };
}
