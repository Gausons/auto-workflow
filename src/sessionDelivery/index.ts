import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual, type Hash } from 'node:crypto';
import path from 'node:path';
import { canonicalWorkspace } from '../tenancy.mjs';
import { asObject, deliverRecord } from './records.ts';
import type { Environment } from '../issueSources/types.ts';

interface Summary {
  id: string; agent: string; title: string; sessionId: string; cwd: string; workspaces: string[];
  model: string; branch: string; updatedAt: string; [key: string]: unknown;
}
interface Source { file: string; root: string; agent: string; allowed: string; session: Summary; current: () => boolean }
export interface HistorySource {
  resolveSource(id: string): Promise<Source>;
  catalog(): Promise<{ sessions: Summary[]; providers: { id: string; [key: string]: unknown }[]; scope: string }>;
}
interface Snapshot {
  id: string; identity: string; size: number; hash: string; allowed: string; offset: number; line: number;
  pendingBytes: number; recordEnd?: number;
}
interface Line { start: number; end: number; line: number; raw?: Buffer; terminated: boolean }
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const PAGE_BYTES = 1024 * 1024;
const error = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const within = (root: string, file: string) => file === root || file.startsWith(root + path.sep);

/** Streaming scan: no whole-session buffer, database copy, or generated package. */
async function* lines(handle: FileHandle, size: number, start = 0, firstLine = 0, hasher?: Hash): AsyncGenerator<Line> {
  let position = start, lineStart = start, number = firstLine, bytes = 0, chunks: Buffer[] = [];
  while (position < size) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) throw error(409, '会话文件已截短，请重新读取会话。');
    let from = 0;
    while (from < bytesRead) {
      const newline = buffer.indexOf(10, from), to = newline >= 0 && newline < bytesRead ? newline + 1 : bytesRead;
      hasher?.update(buffer.subarray(from, to));
      bytes += to - from;
      if (bytes <= MAX_RECORD_BYTES) chunks.push(buffer.subarray(from, to)); else chunks = [];
      if (newline >= 0 && newline < bytesRead) {
        const end = position + to;
        yield { start: lineStart, end, line: ++number, raw: bytes <= MAX_RECORD_BYTES ? Buffer.concat(chunks) : undefined, terminated: true };
        lineStart = end; bytes = 0; chunks = [];
      }
      from = to;
    }
    position += bytesRead;
  }
  if (lineStart < size) yield { start: lineStart, end: size, line: ++number, raw: bytes <= MAX_RECORD_BYTES ? Buffer.concat(chunks) : undefined, terminated: false };
}

async function digest(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024);
  for (let offset = 0; offset < size;) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) throw error(409, '会话文件已截短，请重新读取会话。');
    hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
  }
  return hash.digest('hex');
}

export function createSessionDelivery({ history, environment = {} }: { history: HistorySource; environment?: Environment }) {
  // Cursors authorize no access on their own. They are scoped to this tenant runtime and checked under member auth.
  const signingKey = randomBytes(32);
  const sign = (snapshot: Snapshot) => {
    const body = Buffer.from(JSON.stringify(snapshot)).toString('base64url');
    return `${body}.${createHmac('sha256', signingKey).update(body).digest('base64url')}`;
  };
  function decode(value: string, id: string): Snapshot {
    if (value.length > 4096) throw error(400, '游标无效。');
    const [body, signature, extra] = value.split('.');
    const expected = createHmac('sha256', signingKey).update(body || '').digest();
    const actual = Buffer.from(signature || '', 'base64url');
    if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw error(409, '游标无效或服务已重启，请重新读取会话。');
    let parsed: Snapshot;
    try { parsed = JSON.parse(Buffer.from(body!, 'base64url').toString()); } catch { throw error(400, '游标无效。'); }
    if (parsed.id !== id || ![parsed.offset, parsed.line, parsed.size].every(n => Number.isSafeInteger(n) && n >= 0) || parsed.offset > parsed.size) throw error(400, '游标与会话不匹配。');
    return parsed;
  }
  function number(params: URLSearchParams, key: string, fallback: number, max: number, min = 0): number {
    const raw = params.get(key); if (raw === null) return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) throw error(400, '分页参数无效。');
    return Number(raw);
  }
  async function checkedSource<T>(id: string, work: (source: Source, handle: FileHandle, identity: string, size: number) => Promise<T>): Promise<T> {
    const source = await history.resolveSource(id);
    if (!['codex', 'claude'].includes(source.agent)) throw error(422, '此来源暂不支持完整会话交付。');
    let handle: FileHandle;
    try {
      if (await realpath(source.file) !== source.file || !within(source.root, source.file) || await realpath(source.root) !== source.root) throw new Error();
      handle = await open(source.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch { throw error(404, '会话来源已移除或无法读取。'); }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw error(404, '会话来源不存在。');
      const result = await work(source, handle, `${info.dev}:${info.ino}:${info.birthtimeMs}`, info.size);
      if (!source.current() || await realpath(source.file).catch(() => '') !== source.file) throw error(409, '会话来源或授权范围已变化。');
      const pathHandle = await open(source.file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
      if (!pathHandle) throw error(409, '会话来源已变化。');
      try { const final = await pathHandle.stat(); if (final.dev !== info.dev || final.ino !== info.ino) throw error(409, '会话文件已替换。'); }
      finally { await pathHandle.close(); }
      return result;
    } finally { await handle.close(); }
  }
  async function capture(source: Source, handle: FileHandle, identity: string, size: number): Promise<Snapshot> {
    let bound = 0, sawWorkspace = false;
    const hash = createHash('sha256');
    let version = hash.copy().digest('hex');
    for await (const line of lines(handle, size, 0, 0, hash)) {
      if (!line.terminated) break;
      let row: unknown;
      if (line.raw?.toString('utf8').trim()) {
        try { row = JSON.parse(line.raw.toString('utf8')); }
        catch {
          if (source.allowed !== '*') throw error(404, '无法确认会话的工作区范围。');
        }
      } else if (!line.raw && source.allowed !== '*') throw error(404, '无法确认会话的工作区范围。');
      const record = asObject(row), payload = asObject(record.payload);
      const cwd = source.agent === 'codex' ? (['session_meta', 'turn_context'].includes(String(record.type)) ? payload.cwd : undefined) : record.cwd;
      if (typeof cwd === 'string' && cwd) {
        sawWorkspace = true;
        if (source.allowed !== '*' && (!path.isAbsolute(cwd) || !within(source.allowed, canonicalWorkspace(cwd)))) throw error(404, '会话不在授权工作区内。');
      }
      bound = line.end; version = hash.copy().digest('hex');
    }
    if (source.allowed !== '*' && !sawWorkspace) throw error(404, '无法确认会话的工作区范围。');
    return { id: source.session.id, identity, allowed: source.allowed, size: bound, hash: version, offset: 0, line: 0, pendingBytes: size - bound };
  }
  async function verify(source: Source, handle: FileHandle, identity: string, snapshot: Snapshot) {
    if (snapshot.identity !== identity || snapshot.allowed !== source.allowed || await digest(handle, snapshot.size) !== snapshot.hash) throw error(409, '会话已替换、截短或改写，请重新读取会话。');
  }
  function convert(source: Source, line: Line) {
    if (!line.raw) return { sourceLine: line.line, kind: 'unavailable', reason: 'record_exceeds_16_mib' };
    const text = line.raw.toString('utf8').trim();
    if (!text) return null;
    try { return { sourceLine: line.line, ...deliverRecord(source.agent, JSON.parse(text), environment) }; }
    catch { return { sourceLine: line.line, kind: 'unavailable', reason: 'malformed_json' }; }
  }
  async function page(id: string, params: URLSearchParams, incremental: boolean) {
    const limit = number(params, 'limit', 50, 200, 1);
    if (params.has('cursor') && params.has('after')) throw error(400, '不能同时使用 cursor 和 after。');
    const token = params.get(incremental ? 'after' : 'cursor');
    if (incremental && !token) throw error(400, '增量读取需要 after 游标。');
    if (params.has(incremental ? 'cursor' : 'after')) throw error(400, '游标参数用于错误的接口。');
    return checkedSource(id, async (source, handle, identity, size) => {
      let snapshot = token ? decode(token, id) : await capture(source, handle, identity, size);
      if (snapshot.recordEnd !== undefined) throw error(400, '记录引用不能用作分页游标。');
      await verify(source, handle, identity, snapshot);
      if (incremental && snapshot.offset === snapshot.size) {
        const updated = await capture(source, handle, identity, size);
        snapshot = { ...updated, offset: snapshot.offset, line: snapshot.line };
      }
      const startSnapshot = { ...snapshot, offset: 0, line: 0 };
      let offset = snapshot.offset, lineNumber = snapshot.line, bytes = 0;
      const events: Record<string, unknown>[] = [];
      for await (const line of lines(handle, snapshot.size, offset, lineNumber)) {
        const event = convert(source, line);
        if (event) {
          const length = Buffer.byteLength(JSON.stringify(event));
          if (events.length && (events.length >= limit || bytes + Math.min(length, PAGE_BYTES) > PAGE_BYTES)) break;
          if (length > PAGE_BYTES) {
            const ref = sign({ ...snapshot, offset: line.start, line: line.line - 1, recordEnd: line.end });
            events.push({ sourceLine: line.line, kind: 'reference', bytes: length, href: `/api/sessions/${id}/records?ref=${encodeURIComponent(ref)}` });
          } else events.push(event);
          bytes += Math.min(length, PAGE_BYTES);
        }
        offset = line.end; lineNumber = line.line;
      }
      await verify(source, handle, identity, snapshot);
      const cursor = sign({ ...snapshot, offset, line: lineNumber });
      return {
        session: { id: source.session.id, agent: source.agent }, snapshot: sign(startSnapshot), version: snapshot.hash,
        events, nextCursor: offset < snapshot.size ? cursor : null, eventCursor: cursor,
        coverage: { sourceBytes: snapshot.size, pendingBytes: snapshot.pendingBytes, reachedEnd: offset === snapshot.size,
          unavailableRecords: events.filter(event => event.kind === 'unavailable').length,
          policy: 'Recorded source events; internal reasoning and system/developer messages omitted; known credentials redacted. No context reconstruction.',
          maxRecordBytes: MAX_RECORD_BYTES, linkedResources: 'references_only' },
        handoff: { sessionUrl: `/api/sessions/${id}?cursor=${encodeURIComponent(sign(startSnapshot))}`, incrementalUrl: `/api/sessions/${id}/events?after=${encodeURIComponent(cursor)}`, trust: 'source_reference' }
      };
    });
  }
  return {
    async list(params = new URLSearchParams()) {
      const offset = number(params, 'offset', 0, 1_000_000), limit = number(params, 'limit', 30, 200, 1);
      const q = (params.get('q') || '').trim().toLowerCase(), agent = params.get('agent') || '', workspace = params.get('workspace') || '';
      if (q.length > 200) throw error(400, '搜索词不能超过 200 字符。');
      const timestamp = (key: string) => { const raw = params.get(key); if (!raw) return null; const parsed = Date.parse(raw); if (!Number.isFinite(parsed)) throw error(400, '时间筛选参数无效。'); return parsed; };
      const from = timestamp('from'), to = timestamp('to');
      if (from !== null && to !== null && from > to) throw error(400, '时间范围无效。');
      if (workspace && workspace !== '__unknown__' && !path.isAbsolute(workspace)) throw error(400, '工作区筛选必须是绝对路径。');
      const selectedWorkspace = workspace && workspace !== '__unknown__' ? canonicalWorkspace(workspace) : workspace;
      const result = await history.catalog();
      if (agent && !result.providers.some(p => p.id === agent)) throw error(400, '不支持的 Agent。');
      const summaries = result.sessions.map(session => deliverRecord(session.agent, session, environment).record as Summary);
      const matches = summaries.filter(session => (!agent || session.agent === agent) && (!selectedWorkspace || (selectedWorkspace === '__unknown__' ? !session.workspaces.length : session.workspaces.includes(selectedWorkspace))) &&
        (!q || [session.title, session.sessionId, session.cwd, session.model, session.branch].some(value => value.toLowerCase().includes(q))) &&
        (from === null || Date.parse(session.updatedAt) >= from) && (to === null || Date.parse(session.updatedAt) <= to));
      return { ...result, sessions: matches.slice(offset, offset + limit).map(session => ({ ...session, href: `/api/sessions/${session.id}` })), total: matches.length, offset, limit };
    },
    detail: (id: string, params = new URLSearchParams()) => page(id, params, false),
    events: (id: string, params = new URLSearchParams()) => page(id, params, true),
    async record(id: string, params = new URLSearchParams()) {
      const ref = params.get('ref'); if (!ref) throw error(400, '缺少记录引用。');
      const snapshot = decode(ref, id);
      if (!Number.isSafeInteger(snapshot.recordEnd) || snapshot.recordEnd! <= snapshot.offset || snapshot.recordEnd! > snapshot.size) throw error(400, '记录引用无效。');
      return checkedSource(id, async (source, handle, identity) => {
        await verify(source, handle, identity, snapshot);
        const iterator = lines(handle, snapshot.recordEnd!, snapshot.offset, snapshot.line);
        const { value } = await iterator.next(); await iterator.return(undefined);
        if (!value || value.end !== snapshot.recordEnd) throw error(409, '记录已变化。');
        const event = convert(source, value);
        await verify(source, handle, identity, snapshot);
        return { version: snapshot.hash, event };
      });
    }
  };
}
