import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { httpError } from './rbac.js';
import type { SessionImage } from '../shared/historyImageTypes.js';
import type { Actor, Session } from '../shared/taskTypes.js';

export const HISTORY_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const safeText = (text: string, limit: number) => text.replace(/[\u0000\uD800-\uDFFF]/gu, '\uFFFD').slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '');

export function prepareSessionImage(record: number, index: number, text: string, image: { dataUrl?: string; alt?: string }, timestamp?: string): SessionImage {
  const value = { record, index, text: safeText(text, 1000), alt: safeText(image.alt || '会话图片', 500),
    ...(timestamp ? { timestamp: safeText(timestamp, 100) } : {}), ...(image.dataUrl ? { dataUrl: image.dataUrl } : {}) };
  return { id: createHash('sha256').update(JSON.stringify(value)).digest('hex'), ...value };
}

export function validateSessionImage(value: unknown): SessionImage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '图片格式无效');
  const image = value as SessionImage;
  if (!Number.isSafeInteger(image.record) || image.record < 1 || image.record > 10000 ||
      !Number.isSafeInteger(image.index) || image.index < 0 || image.index >= 100 ||
      typeof image.text !== 'string' || typeof image.alt !== 'string' ||
      (image.timestamp !== undefined && typeof image.timestamp !== 'string')) throw httpError(400, '图片记录格式无效');
  if (image.dataUrl !== undefined) {
    if (typeof image.dataUrl !== 'string' || image.dataUrl.length > HISTORY_IMAGE_MAX_BYTES * 4 / 3 + 100 ||
        !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(image.dataUrl) ||
        Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64').length > HISTORY_IMAGE_MAX_BYTES) throw httpError(400, '图片格式不支持或超过 12 MiB');
  }
  const normalized = prepareSessionImage(image.record, image.index, image.text, image, image.timestamp);
  if (!isDeepStrictEqual(normalized, value)) throw httpError(400, '图片摘要或元数据无效');
  return image;
}

type Database = ReturnType<typeof import('./database.js').openDatabase>;
export function createHistoryImages(database: Database, tenantId: string) {
  const session = (id: string): Session => {
    const found = database.readTaskCenter(tenantId).sessions.find(item => item.id === id && item.deviceId !== 'local' && item.recordMode === 'synced');
    if (!found) throw httpError(404, '会话不存在或未开启正文同步');
    return found;
  };
  return {
    upload(input: Record<string, unknown>, actor: Actor) {
      const image = validateSessionImage(input.image);
      return database.mutateTaskCenter(tenantId, data => {
        const device = data.devices.find(item => item.id === input.deviceId);
        if (!device || device.owner !== actor.id) throw httpError(403, '设备不存在或属于其他账号');
        // Workbench conversations/executions can share the native identity of
        // a separate synced history record. Images belong to that history.
        const found = data.sessions.find(item => item.deviceId === device.id && item.nativeId === input.nativeId && item.agent === input.agent && item.recordMode === 'synced');
        if (!found) throw httpError(404, '会话不存在或未开启正文同步');
        if (image.record > (found.syncedRange?.total || 0)) throw httpError(409, '会话记录已变化，请重新同步');
        database.saveRemoteSessionImage(tenantId, found.id, image);
        found.syncedImageCount = database.listRemoteSessionImages(tenantId, found.id, 0, 1).total;
        return { id: image.id };
      });
    },
    list(id: string, params: URLSearchParams) {
      session(id);
      const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 20);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw httpError(400, '分页参数无效');
      return database.listRemoteSessionImages(tenantId, id, offset, limit);
    },
    read(id: string, imageId: string) {
      session(id);
      const image = database.readRemoteSessionImage(tenantId, id, imageId);
      if (!image) throw httpError(404, '图片不存在');
      return image;
    }
  };
}
