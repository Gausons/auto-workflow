import { createHash } from 'node:crypto';
import { verifySnapshot, type ContextEvent, type ContextSnapshot } from './index.js';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const invalid = (message: string) => Object.assign(new Error(message), { code: 'INVALID_BUNDLE' });
const imagePattern = /data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)/g;
const maxObjectBytes = 12 * 1024 * 1024;
const maxObjectTotal = 50 * 1024 * 1024;
const maxEventBytes = 85 * 1024 * 1024;
type TextSegment = { type: 'text'; value: string };
type ObjectSegment = { type: 'object'; digest: string; mimeType: string };
export type Segment = TextSegment | ObjectSegment;
export type DetachedEvent = Omit<ContextEvent, 'text'> & { fieldOrder: string[]; segments: Segment[] };
export interface ObjectDescriptor { digest: string; mimeType: string; bytes: number }
export interface DetachedManifest {
  schemaVersion: 3;
  snapshot: Omit<ContextSnapshot, 'entries'>;
  events: DetachedEvent[];
  objects: ObjectDescriptor[];
  manifestDigest: string;
}
export interface DetachedBundle {
  manifest: DetachedManifest;
  objects: Array<ObjectDescriptor & { data: Uint8Array }>;
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const mediaTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const manifestHash = (manifest: Omit<DetachedManifest, 'manifestDigest'>) => digest(JSON.stringify(manifest));

function imageMatches(bytes: Uint8Array, mimeType: string): boolean {
  const data = Buffer.from(bytes);
  if (mimeType === 'image/png') return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mimeType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'));
  return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
}

export function detachSnapshot(snapshot: ContextSnapshot): DetachedBundle {
  verifySnapshot(snapshot);
  const found = new Map<string, ObjectDescriptor & { data: Uint8Array }>();
  let total = 0;
  const events: DetachedEvent[] = snapshot.entries.map(entry => {
    const segments: Segment[] = [];
    let cursor = 0;
    for (const match of entry.text.matchAll(imagePattern)) {
      const [uri, mimeType, encoded] = match;
      if (match.index === undefined || !mimeType || !encoded) continue;
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded || !imageMatches(bytes, mimeType)) continue;
      if (bytes.length > maxObjectBytes) throw invalid('历史图片超过单对象限制');
      if (match.index > cursor) segments.push({ type: 'text', value: entry.text.slice(cursor, match.index) });
      const key = digest(bytes);
      if (!found.has(key)) {
        total += bytes.length;
        if (total > maxObjectTotal || found.size >= 1000) throw invalid('历史图片超过交接总量限制');
        found.set(key, { digest: key, mimeType, bytes: bytes.length, data: bytes });
      } else if (found.get(key)!.mimeType !== mimeType) throw invalid('相同对象声明了不同图片类型');
      segments.push({ type: 'object', digest: key, mimeType });
      cursor = match.index + uri.length;
    }
    if (cursor < entry.text.length || segments.length === 0) segments.push({ type: 'text', value: entry.text.slice(cursor) });
    const { text: _text, ...rest } = entry;
    return { ...rest, fieldOrder: Object.keys(entry), segments };
  });
  const objects = [...found.values()];
  const { entries: _entries, ...metadata } = snapshot;
  const body = { schemaVersion: 3 as const, snapshot: metadata, events,
    objects: objects.map(({ digest, mimeType, bytes }) => ({ digest, mimeType, bytes })) };
  const manifest: DetachedManifest = { ...body, manifestDigest: manifestHash(body) };
  verifyDetachedManifest(manifest);
  return { manifest, objects };
}

export function verifyDetachedManifest(value: unknown): DetachedManifest {
  if (!isRecord(value) || value.schemaVersion !== 3 || !isRecord(value.snapshot) ||
      !Array.isArray(value.events) || value.events.length > 100000 || !Array.isArray(value.objects) || value.objects.length > 1000 ||
      typeof value.manifestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifestDigest)) throw invalid('交接清单格式无效');
  const descriptors = new Map<string, ObjectDescriptor>();
  let total = 0;
  for (const item of value.objects) {
    if (!isRecord(item) || typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest) ||
        typeof item.mimeType !== 'string' || !mediaTypes.has(item.mimeType) || !Number.isSafeInteger(item.bytes) ||
        (item.bytes as number) < 1 || (item.bytes as number) > maxObjectBytes || descriptors.has(item.digest)) throw invalid('交接对象描述无效');
    total += item.bytes as number;
    if (total > maxObjectTotal) throw invalid('交接对象总量超限');
    descriptors.set(item.digest, item as unknown as ObjectDescriptor);
  }
  const used = new Set<string>();
  let textBytes = 0;
  for (const entry of value.events) {
    if (!isRecord(entry) || !['user', 'assistant', 'tool_call', 'tool_result', 'reference'].includes(String(entry.role)) ||
        typeof entry.source !== 'string' || !Array.isArray(entry.segments) || !entry.segments.length || entry.segments.length > 10000 ||
        !Array.isArray(entry.fieldOrder) || !entry.fieldOrder.includes('text') || !entry.fieldOrder.includes('role') || !entry.fieldOrder.includes('source') ||
        new Set(entry.fieldOrder).size !== entry.fieldOrder.length ||
        entry.fieldOrder.some(key => !['role', 'text', 'source', 'line', 'timestamp', 'turnId'].includes(String(key)))) throw invalid('交接事件格式无效');
    for (const segment of entry.segments) {
      if (!isRecord(segment)) throw invalid('交接内容格式无效');
      if (segment.type === 'text' && typeof segment.value === 'string') textBytes += Buffer.byteLength(segment.value);
      else if (segment.type === 'object' && typeof segment.digest === 'string' && typeof segment.mimeType === 'string' && descriptors.get(segment.digest)?.mimeType === segment.mimeType) used.add(segment.digest);
      else throw invalid('交接内容引用无效');
      if (textBytes > maxEventBytes) throw invalid('交接事件正文超限');
    }
  }
  if (used.size !== descriptors.size) throw invalid('交接清单包含无引用对象');
  const { manifestDigest, ...body } = value;
  if (manifestHash(body as Omit<DetachedManifest, 'manifestDigest'>) !== manifestDigest) throw invalid('交接清单摘要无效');
  return value as unknown as DetachedManifest;
}

export function restoreDetachedSnapshot(manifestValue: unknown, objects: ReadonlyMap<string, Uint8Array>): ContextSnapshot {
  const manifest = verifyDetachedManifest(manifestValue);
  const materialized = new Map<string, string>();
  for (const item of manifest.objects) {
    const bytes = objects.get(item.digest);
    if (!bytes || bytes.byteLength !== item.bytes || digest(bytes) !== item.digest || !imageMatches(bytes, item.mimeType)) throw invalid('交接对象缺失或已损坏');
    materialized.set(item.digest, `data:${item.mimeType};base64,${Buffer.from(bytes).toString('base64')}`);
  }
  const entries: ContextEvent[] = manifest.events.map(({ segments, fieldOrder, ...entry }) => {
    const text = segments.map(segment => segment.type === 'text' ? segment.value : materialized.get(segment.digest)!).join('');
    const restored: Record<string, unknown> = {};
    for (const key of fieldOrder) restored[key] = key === 'text' ? text : (entry as Record<string, unknown>)[key];
    return restored as unknown as ContextEvent;
  });
  try { return verifySnapshot({ ...manifest.snapshot, entries }); }
  catch { throw invalid('还原后的来源快照校验失败'); }
}
