import { historyTurnPage } from '../shared/historyTurns.js';
import type { HistoryMessage } from '../shared/taskTypes.js';
import { httpError } from './rbac.js';

export function paginateHistoryTurns<T extends HistoryMessage>(messages: T[], params: URLSearchParams) {
  const limit = Number(params.get('turns'));
  const rawBefore = params.get('before');
  const before = rawBefore === null ? messages.length : Number(rawBefore);
  if (!/^[0-9]+$/.test(params.get('turns') || '') || !Number.isSafeInteger(limit) || limit < 1 || limit > 10 ||
      (rawBefore !== null && !/^[0-9]+$/.test(rawBefore)) || !Number.isSafeInteger(before) || before < 0 || before > messages.length) throw httpError(400, '轮次分页参数无效');
  return historyTurnPage(messages, before, limit);
}
