import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { canonicalWorkspace } from '../tenancy.js';
import { httpError } from '../rbac.js';
import type { Environment } from '../issueSources/types.js';
import { defaultHistoryAdapters } from './adapters.js';
import type { HistoryAdapter, HistoryEntry, HistorySession, JsonObject } from './types.js';

interface AgentHistoryOptions {
  environment?: Environment;
  tenantId?: string;
  workspace?: () => string;
  rootDir?: string;
  adapters?: HistoryAdapter[];
}
interface Provider { [key: string]: unknown; id: string; label: string; status: 'unconfigured' | 'missing' | 'available' | 'error'; skipped: number }
interface SourceFile { file: string; adapter: HistoryAdapter; root: string }
interface ScanResult {
  sessions: HistorySession[];
  providers: Provider[];
  files: Map<string, SourceFile>;
  allowed: string | null;
}
interface CacheEntry { signature: string; session: HistorySession | null }

const record = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const within = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 10000;

export function createAgentHistory({ environment = {}, tenantId = 'default', workspace, rootDir = process.cwd(), adapters = defaultHistoryAdapters }: AgentHistoryOptions) {
  const registry = new Map<string, HistoryAdapter>();
  for (const adapter of adapters) {
    if (!/^[a-z][a-z0-9-]*$/.test(adapter.id) || registry.has(adapter.id) || typeof adapter.decode !== 'function' || typeof adapter.roots !== 'function') throw new Error('无效或重复的历史会话适配器');
    registry.set(adapter.id, adapter);
  }
  const cache = new Map<string, CacheEntry>();
  let pending: Promise<ScanResult> | null = null, latest: ScanResult | null = null;
  function scope() {
    if (environment.IDE_HISTORY_SCOPE !== 'workspace') return '*';
    const value = workspace?.(); return value ? canonicalWorkspace(value) : null;
  }
  function authorized(cwd: unknown, allowed: string | null): cwd is string { return typeof cwd === 'string' && path.isAbsolute(cwd) && allowed !== null && (allowed === '*' || within(allowed, canonicalWorkspace(cwd))); }

  async function parse(file: string, adapter: HistoryAdapter, allowed: string | null, info: Stats, detail = false): Promise<HistorySession | null> {
    const session: HistorySession = { id: createHash('sha256').update(`${adapter.id}\0${file}`).digest('hex'), agent: adapter.id, agentLabel: adapter.label, deviceId: 'local',
      sessionId: '', title: '', cwd: '', workspaces: [], model: '', branch: '', status: 'unknown', archived: file.split(path.sep).includes('archived_sessions'),
      createdAt: '', updatedAt: '', messageCount: 0, partial: info.size > MAX_BYTES };
    const entries: HistoryEntry[] = [], fallback: HistoryEntry[] = [];
    let count = 0, fallbackCount = 0, firstPrompt = '', fallbackPrompt = '', malformed = 0, conversationCount = 0;
    let turnId: string | undefined;
    const checkedCwds = new Map<string, string | null>();
    const stream = createReadStream(file, { encoding: 'utf8', start: 0, end: MAX_BYTES - 1 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { malformed++; continue; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const row = record(parsed);
        const decoded = adapter.decode(row);
        const payload = record(row.payload);
        if (adapter.id === 'codex' && (row.type === 'turn_context' || (row.type === 'event_msg' && payload.type === 'task_started'))) turnId = typeof payload.turn_id === 'string' ? payload.turn_id : turnId;
        if (decoded.cwd) {
          if (typeof decoded.cwd !== 'string') return null;
          const cwd = decoded.cwd;
          if (!checkedCwds.has(cwd)) checkedCwds.set(cwd, authorized(cwd, allowed) ? canonicalWorkspace(cwd) : null);
          const canonical = checkedCwds.get(cwd);
          if (!canonical) return null;
          session.cwd ||= cwd;
          if (!session.workspaces.includes(canonical)) session.workspaces.push(canonical);
        }
        for (const key of ['title', 'model', 'branch', 'status'] as const) {
          const value = decoded[key];
          if (typeof value === 'string' && value) session[key] = value.slice(0, 500);
        }
        if (decoded.id) session.sessionId = String(decoded.id).slice(0, 250);
        const timestamp = date(row.timestamp);
        if (timestamp) { session.createdAt ||= timestamp; session.updatedAt = timestamp; }
        const createdAt = date(decoded.createdAt);
        if (createdAt) session.createdAt = createdAt;
        for (const item of decoded.entries || []) {
          if (!item.text && !item.images?.length) continue;
          if (turnId) item.turnId = turnId;
          if (decoded.fallback) {
            fallbackCount++;
            if (item.role === 'user') fallbackPrompt ||= item.text || (item.images?.length ? '图片会话' : '');
            if (detail && fallback.length < MAX_ENTRIES) fallback.push(item);
          } else {
            count++;
            if (['user', 'assistant'].includes(item.role)) conversationCount++;
            if (item.role === 'user') firstPrompt ||= item.text || (item.images?.length ? '图片会话' : '');
            if (detail && entries.length < MAX_ENTRIES) entries.push(item);
          }
        }
      }
    } finally { lines.close(); stream.destroy(); }
    if (!session.cwd && allowed !== '*') return null;
    if (!session.cwd && !session.sessionId && !count && !fallbackCount) return null;
    // Codex emits both response_item and event_msg copies of the conversation.
    session.messageCount = count + (conversationCount ? 0 : fallbackCount);
    session.title ||= (fallbackPrompt || firstPrompt).replace(/\s+/g, ' ').slice(0, 120) || '未命名会话';
    session.updatedAt ||= info.mtime.toISOString();
    session.createdAt ||= session.updatedAt;
    session.partial ||= malformed > 0 || session.messageCount > MAX_ENTRIES;
    const messages = conversationCount ? entries : [...entries, ...fallback].sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || ''))).slice(0, MAX_ENTRIES);
    return { ...session, ...(detail ? { messages } : {}) };
  }

  async function scan(): Promise<ScanResult> {
    const allowed = scope(), sessions: HistorySession[] = [], providers: Provider[] = [], files = new Map<string, SourceFile>(), alive = new Set<string>();
    if (!allowed) return { sessions, providers: [...registry.values()].map(({ id, label }) => ({ id, label, status: 'unconfigured', skipped: 0 })), files, allowed };
    for (const adapter of registry.values()) {
      const roots = adapter.roots(environment, tenantId);
      const provider: Provider = { id: adapter.id, label: adapter.label, status: roots.length ? 'missing' : 'unconfigured', skipped: 0 };
      for (const source of roots) {
        let root: string;
        try { root = await realpath(path.resolve(rootDir, source)); }
        catch (error: unknown) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) provider.status = 'error'; continue; }
        if (provider.status !== 'error') provider.status = 'available';
        async function walk(dir: string, depth = 0) {
          if (depth > 12) { provider.skipped++; return; }
          let children;
          try { children = await readdir(dir, { withFileTypes: true }); }
          catch { provider.skipped++; return; }
          for (const child of children) {
            const filename = path.join(dir, child.name);
            // Do not traverse symlinks or serve arbitrary paths supplied by clients.
            if (child.isDirectory()) { await walk(filename, depth + 1); continue; }
            if (!child.isFile() || !child.name.endsWith('.jsonl')) continue;
            try {
              const file = await realpath(filename);
              if (!within(root, file)) continue;
              const info = await stat(file), key = `${adapter.id}\0${file}`;
              alive.add(key);
              const signature = `${allowed}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
              let cached = cache.get(key);
              if (cached?.signature !== signature) {
                cached = { signature, session: await parse(file, adapter, allowed, info) };
                cache.set(key, cached);
              }
              if (!cached.session || files.has(cached.session.id)) continue;
              sessions.push(cached.session);
              files.set(cached.session.id, { file, adapter, root });
            } catch { provider.skipped++; }
          }
        }
        await walk(root);
      }
      providers.push(provider);
    }
    for (const key of cache.keys()) if (!alive.has(key)) cache.delete(key);
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return { sessions, providers, files, allowed };
  }
  async function index() {
    if (!pending) pending = scan().then((result) => { latest = result; return result; }).finally(() => { pending = null; });
    return pending;
  }
  function pagination(params: URLSearchParams, defaultLimit: number) {
    const number = (key: 'offset' | 'limit', fallback: number, max: number) => {
      const raw = params.get(key); if (raw === null) return fallback;
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max || (key === 'limit' && Number(raw) === 0)) throw httpError(400, '分页参数无效');
      return Number(raw);
    };
    return { offset: number('offset', 0, 1000000), limit: number('limit', defaultLimit, 200) };
  }
  return {
    async catalog() {
      const result = await index();
      return { sessions: result.sessions, providers: result.providers, scope: result.allowed === '*' ? 'all' : 'workspace' };
    },
    async resolveSource(id: string) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw httpError(404, '会话不存在');
      let result = latest?.allowed === scope() ? latest : await index();
      if (!result.files.has(id)) result = await index();
      const source = result.files.get(id);
      if (!source || !result.allowed || scope() !== result.allowed) throw httpError(404, '会话不存在');
      const session = result.sessions.find(candidate => candidate.id === id);
      if (!session) throw httpError(404, '会话不存在');
      return { file: source.file, root: source.root, agent: source.adapter.id, allowed: result.allowed,
        session, current: () => scope() === result.allowed };
    },
    async list(params = new URLSearchParams()) {
      const agent = params.get('agent') || '', q = (params.get('q') || '').trim().toLowerCase();
      if (agent && !registry.has(agent)) throw httpError(400, '不支持的 Agent');
      if (q.length > 200) throw httpError(400, '搜索词不能超过 200 字符');
      const { offset, limit } = pagination(params, 30);
      const result = await index();
      const selectedWorkspace = params.get('workspace') || '';
      const workspaceCounts = new Map<string, number>();
      for (const s of result.sessions) {
        if (agent && s.agent !== agent) continue;
        for (const cwd of s.workspaces.length ? s.workspaces : ['__unknown__']) workspaceCounts.set(cwd, (workspaceCounts.get(cwd) || 0) + 1);
      }
      const workspaces = [...workspaceCounts].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path));
      const matches = result.sessions.filter(session => (!selectedWorkspace || (selectedWorkspace === '__unknown__' ? !session.workspaces.length : session.workspaces.includes(selectedWorkspace))) && (!agent || session.agent === agent) && (!q || [session.title, session.cwd, session.sessionId, session.model, session.branch].some(value => value.toLowerCase().includes(q))));
      return { providers: result.providers, sessions: matches.slice(offset, offset + limit), total: matches.length, offset, limit, workspace: selectedWorkspace, workspaces, scope: result.allowed === '*' ? 'all' : 'workspace' };
    },
    async detail(id: string, params = new URLSearchParams()) {
      const { offset, limit } = pagination(params, 100);
      if (!/^[a-f0-9]{64}$/.test(id)) throw httpError(404, '会话不存在');
      const result = await index(), source = result.files.get(id);
      if (!source || scope() !== result.allowed) throw httpError(404, '会话不存在');
      let session;
      try {
        if (await realpath(source.file) !== source.file) throw new Error('source changed');
        session = await parse(source.file, source.adapter, result.allowed, await stat(source.file), true);
      } catch { throw httpError(404, '会话已移除或无法读取'); }
      if (!session || scope() !== result.allowed) throw httpError(404, '会话不存在');
      const { messages = [], ...summary } = session;
      return { session: summary, messages: messages.slice(offset, offset + limit), total: messages.length, offset, limit };
    }
  };
}
