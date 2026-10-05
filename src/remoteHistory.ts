import { isDeepStrictEqual } from 'node:util';
import type { HistoryMessage, RemoteHistory, Session } from '../shared/taskTypes.js';
import { httpError } from './rbac.js';

export const REMOTE_HISTORY_LIMIT = 30;
const TEXT_LIMIT = 23000;
const IMAGE_BUDGET = 256 * 1024;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

// Prepare source records on the connector. Oversize or unavailable content
// remains visible as an explicit gap in the bounded preview.
export function normalizeRemoteHistory(value: unknown): RemoteHistory {
  const input = object(value);
  if (!Array.isArray(input.messages) || input.messages.length > REMOTE_HISTORY_LIMIT ||
      !Number.isSafeInteger(input.offset) || Number(input.offset) < 0 ||
      !Number.isSafeInteger(input.total) || Number(input.total) < Number(input.offset) + input.messages.length ||
      typeof input.sourcePartial !== 'boolean' || typeof input.truncated !== 'boolean') throw httpError(400, '远程历史记录范围无效');
  let textBudget = TEXT_LIMIT, imageBudget = IMAGE_BUDGET, truncated = input.truncated;
  function previewText(value: string, limit = value.length) {
    // JSONB rejects NUL and unpaired UTF-16 surrogates. In Unicode mode the
    // surrogate range leaves complete pairs intact; never split one at a limit.
    const safe = value.replace(/[\u0000\uD800-\uDFFF]/gu, '\uFFFD');
    const result = safe.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '');
    if (result !== value) truncated = true;
    return result;
  }
  const messages: HistoryMessage[] = [];
  const rows = [...input.messages].reverse();
  for (const [index, value] of rows.entries()) {
    const row = object(value);
    if (!['user', 'assistant', 'tool_call', 'tool_result'].includes(String(row.role)) || typeof row.text !== 'string' ||
        (row.images !== undefined && (!Array.isArray(row.images) || row.images.length > 100))) throw httpError(400, '远程历史消息格式无效');
    const notice = '\n[内容超过同步上限，已截断]';
    // Reserve a readable snippet for older messages so a large tool result
    // cannot turn all preceding user messages into empty bubbles.
    const available = textBudget - (rows.length - index - 1) * 200;
    const content = row.text.length <= available ? previewText(row.text) : previewText(row.text, available - notice.length) + notice;
    textBudget -= content.length;
    if (content.length < row.text.length) truncated = true;
    const message: HistoryMessage = { role: String(row.role), text: content };
    if (row.phase !== undefined) {
      if (row.phase !== 'commentary' && row.phase !== 'final') throw httpError(400, '远程历史消息阶段无效');
      if (row.role === 'assistant') message.phase = row.phase;
    }
    for (const key of ['name', 'callId', 'turnId', 'timestamp'] as const) {
      if (row[key] !== undefined) {
        if (typeof row[key] !== 'string' || row[key].length > 500) throw httpError(400, '远程历史消息元数据无效');
        message[key] = previewText(row[key]);
      }
    }
    if (Array.isArray(row.images)) message.images = row.images.map(value => {
      const image = object(value);
      const alt = typeof image.alt === 'string' ? previewText(image.alt, 500) : '会话图片';
      if (typeof image.dataUrl === 'string' && image.dataUrl.length <= imageBudget && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(image.dataUrl)) {
        imageBudget -= image.dataUrl.length;
        return { dataUrl: image.dataUrl, alt };
      }
      truncated = true;
      return { alt: image.dataUrl ? '图片未同步：超过同步上限或格式不支持，请在来源设备查看。' : alt };
    });
    messages.unshift(message);
  }
  return { messages, offset: Number(input.offset), total: Number(input.total), sourcePartial: input.sourcePartial, truncated };
}

// The server accepts the current wire format without repairing uploaded data.
export function validateRemoteHistory(value: unknown): RemoteHistory {
  const history = normalizeRemoteHistory(value);
  if (!isDeepStrictEqual(history, value)) throw httpError(400, '远程历史预览不符合当前同步格式');
  return history;
}

// Large preview bodies belong only in the paginated detail response, never in
// the global task snapshot or the history list.
export function remoteHistorySummary(session: Session): Session {
  const { remoteHistory, ...summary } = session;
  if (!remoteHistory) return summary;
  const { messages, ...syncedRange } = remoteHistory;
  return { ...summary, recordMode: 'synced', syncedRange, messageCount: remoteHistory.total,
    partial: remoteHistory.sourcePartial || remoteHistory.truncated || remoteHistory.offset > 0 || messages.length < remoteHistory.total };
}
