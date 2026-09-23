import { createHash, randomUUID } from 'node:crypto';

/** Portable evidence. Source adapters may only emit records they are authorized to export. */
export interface ContextEvent {
  role: string;
  text: string;
  source: string;
  line?: number;
  timestamp?: string;
  turnId?: string;
}
export interface CaptureResult {
  events: ContextEvent[];
  sources: string[];
  partial: boolean;
}
export interface SourceAdapter<Ref = string> {
  readonly id: string;
  capture(ref: Ref): Promise<CaptureResult>;
}
export interface ContextSnapshot {
  id: string;
  version: 1;
  digest: string;
  entries: ContextEvent[];
  sources: string[];
  partial: boolean;
  createdAt: string;
}

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const roles = new Set(['user', 'assistant', 'tool_call', 'tool_result', 'reference']);
const bad = (message: string) => Object.assign(new Error(message), { code: 'INVALID_CONTEXT' });

export function snapshotDigest(entries: ContextEvent[], sources: string[], partial: boolean): string {
  // This exact serialization is the published SessionContext v1 format.
  return hash(JSON.stringify({ version: 1, entries, sources, partial }));
}

export function verifySnapshot(value: unknown): ContextSnapshot {
  const row = object(value);
  if (!row || row.version !== 1 || typeof row.id !== 'string' || !/^(?:[a-f0-9-]{36}|[a-f0-9]{64})$/.test(row.id) ||
      typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)) ||
      typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest) ||
      !Array.isArray(row.entries) || row.entries.length > 100000 ||
      !Array.isArray(row.sources) || row.sources.length > 10000 || typeof row.partial !== 'boolean') throw bad('交接快照格式无效');
  for (const item of row.entries) {
    const entry = object(item);
    if (!entry || !roles.has(String(entry.role)) || typeof entry.text !== 'string' || typeof entry.source !== 'string' || entry.source.length > 4096 ||
        (entry.line !== undefined && (!Number.isSafeInteger(entry.line) || (entry.line as number) < 0)) ||
        (entry.turnId !== undefined && typeof entry.turnId !== 'string') ||
        (entry.timestamp !== undefined && typeof entry.timestamp !== 'string')) throw bad('交接快照记录格式无效');
  }
  if (row.sources.some(item => typeof item !== 'string' || item.length > 4096) ||
      snapshotDigest(row.entries as ContextEvent[], row.sources as string[], row.partial) !== row.digest) throw bad('交接快照校验失败');
  return row as unknown as ContextSnapshot;
}

export function freezeSnapshot(events: ContextEvent[], sources: string[], partial = false): ContextSnapshot {
  const entries = structuredClone(events), uniqueSources = [...new Set(sources)];
  const snapshot = { id: randomUUID(), version: 1 as const, entries, sources: uniqueSources, partial,
    digest: snapshotDigest(entries, uniqueSources, partial), createdAt: new Date().toISOString() };
  return verifySnapshot(snapshot);
}

export class SourceRegistry {
  private readonly sources = new Map<string, SourceAdapter<unknown>>();
  register<Ref>(source: SourceAdapter<Ref>): void {
    if (!/^[a-z][a-z0-9-]*$/.test(source.id) || this.sources.has(source.id)) throw bad('数据源名称无效或已注册');
    this.sources.set(source.id, source as SourceAdapter<unknown>);
  }
  async capture<Ref>(id: string, ref: Ref): Promise<CaptureResult> {
    const source = this.sources.get(id);
    if (!source) throw bad(`不支持的数据源：${id}`);
    const captured = await source.capture(ref);
    verifySnapshot({ id: '00000000-0000-0000-0000-000000000000', version: 1, createdAt: new Date().toISOString(), ...captured,
      entries: captured.events, digest: snapshotDigest(captured.events, captured.sources, captured.partial) });
    return captured;
  }
  ids(): string[] { return [...this.sources.keys()]; }
}

/** v2 transport envelope. v1 snapshots remain readable without changing their digest. */
export interface ContextBundle {
  schemaVersion: 2;
  snapshot: ContextSnapshot;
  objects: Array<{ digest: string; mimeType: string; bytes: number; data: string }>;
  manifestDigest: string;
}
const bundleManifest = (snapshot: ContextSnapshot, objects: ContextBundle['objects']) => ({
  schemaVersion: 2, snapshotId: snapshot.id, snapshotDigest: snapshot.digest, createdAt: snapshot.createdAt,
  objects: objects.map(({ digest, mimeType, bytes }) => ({ digest, mimeType, bytes }))
});
export function packSnapshot(snapshot: ContextSnapshot, assets: Array<{ mimeType: string; bytes: Uint8Array }> = []): ContextBundle {
  verifySnapshot(snapshot);
  const seen = new Set<string>();
  const objects = assets.map(asset => ({ digest: hash(asset.bytes), mimeType: asset.mimeType, bytes: asset.bytes.byteLength,
    data: Buffer.from(asset.bytes).toString('base64') })).filter(item => {
      if (seen.has(item.digest)) return false;
      seen.add(item.digest); return true;
    });
  return { schemaVersion: 2, snapshot, objects, manifestDigest: hash(JSON.stringify(bundleManifest(snapshot, objects))) };
}
export function verifyBundle(value: unknown, limits = { maxObjects: 1000, maxBytes: 85 * 1024 * 1024 }): ContextBundle {
  const row = object(value);
  if (!row || row.schemaVersion !== 2 || typeof row.manifestDigest !== 'string' || !Array.isArray(row.objects) ||
      row.objects.length > limits.maxObjects) throw bad('交接数据包格式无效');
  const snapshot = verifySnapshot(row.snapshot);
  let total = 0;
  const seen = new Set<string>();
  const objects = row.objects.map(item => {
    const asset = object(item);
    if (!asset || typeof asset.digest !== 'string' || !/^[a-f0-9]{64}$/.test(asset.digest) ||
        typeof asset.mimeType !== 'string' || asset.mimeType.length > 200 ||
        !Number.isSafeInteger(asset.bytes) || (asset.bytes as number) < 0 || typeof asset.data !== 'string') throw bad('交接对象格式无效');
    total += asset.bytes as number;
    if (total > limits.maxBytes || seen.has(asset.digest)) throw bad('交接数据包超限或对象重复');
    seen.add(asset.digest);
    const bytes = Buffer.from(asset.data, 'base64');
    if (bytes.length !== asset.bytes || bytes.toString('base64') !== asset.data || hash(bytes) !== asset.digest) throw bad('交接对象校验失败');
    return asset as unknown as ContextBundle['objects'][number];
  });
  if (hash(JSON.stringify(bundleManifest(snapshot, objects))) !== row.manifestDigest) throw bad('交接清单校验失败');
  return row as unknown as ContextBundle;
}
