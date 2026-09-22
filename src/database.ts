import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeIssueState } from './issueStore.js';
import { createIdentityStore } from './identity.js';
import type { IssueState } from './issueStore.js';
import type { WorkIssue } from './issueSources/types.js';
import type { TaskCenterData } from '../public/taskTypes.js';
import type { SessionContext } from './contextCompiler.js';

export interface Tenant { id: string; name: string; createdAt?: string }
export interface TenantSettings { config: Record<string, unknown>; assignmentPeople: unknown[] }
type JsonRecord = Record<string, unknown>;
const emptyTaskCenter = '{"tasks":[],"devices":[],"sessions":[],"handoffs":[]}';
const record = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const parseTaskCenter = (value: unknown): TaskCenterData => JSON.parse(String(value || emptyTaskCenter)) as TaskCenterData;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function openDatabase(filename: string) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (version > 5) { db.close(); throw new Error('数据库版本高于当前程序支持的版本'); }
  if (version === 0) {
    transaction(() => {
      db.exec(readFileSync(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
      db.exec('PRAGMA user_version = 1');
    });
  }
  if (version < 2) {
    transaction(() => {
      db.exec(readFileSync(new URL('../migrations/002_rbac.sql', import.meta.url), 'utf8'));
      db.exec('PRAGMA user_version = 2');
    });
  }

  if (version < 3) {
    transaction(() => {
      db.exec(readFileSync(new URL('../migrations/003_task_center.sql', import.meta.url), 'utf8'));
      db.exec('PRAGMA user_version = 3');
    });
  }
  if (version < 4) {
    transaction(() => {
      db.exec(readFileSync(new URL('../migrations/004_remove_workflows.sql', import.meta.url), 'utf8'));
      db.exec('PRAGMA user_version = 4');
    });
  }

  if (version < 5) {
    transaction(() => {
      db.exec(readFileSync(new URL('../migrations/005_session_context.sql', import.meta.url), 'utf8'));
      db.exec('PRAGMA user_version = 5');
    });
  }

  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function createTenant({ id, name = id, token }: { id: string; name?: string; token: string }): Tenant | undefined {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(id)) throw new Error('租户 ID 仅支持小写字母、数字、下划线和短横线，最多 63 个字符');
    if (typeof token !== 'string' || token.length < 32) throw new Error('租户令牌至少需要 32 个字符');
    transaction(() => {
      db.prepare('INSERT INTO tenants VALUES (?, ?, ?, ?)').run(id, name, hashToken(token), new Date().toISOString());
      db.prepare('INSERT INTO tenant_settings(tenant_id) VALUES (?)').run(id);
    });
    return getTenant(id);
  }
  function getTenant(id: string): Tenant | undefined {
    return db.prepare('SELECT id, name, created_at AS createdAt FROM tenants WHERE id = ?').get(id) as unknown as Tenant | undefined;
  }
  function authenticate(token: unknown): Tenant | null {
    if (typeof token !== 'string' || !token || token.length > 512) return null;
    return db.prepare('SELECT id, name, created_at AS createdAt FROM tenants WHERE token_hash = ?').get(hashToken(token)) as unknown as Tenant || null;
  }
  function readSettings(tenantId: string): TenantSettings {
    const row = db.prepare('SELECT config, assignment_people FROM tenant_settings WHERE tenant_id = ?').get(tenantId) as unknown as { config: string; assignment_people: string } | undefined;
    if (!row) throw new Error('租户不存在');
    return { config: record(JSON.parse(row.config)), assignmentPeople: JSON.parse(row.assignment_people) as unknown[] };
  }
  function writeSettings(tenantId: string, { config, assignmentPeople }: { config?: Record<string, unknown>; assignmentPeople?: unknown[] }) {
    if (config !== undefined) db.prepare('UPDATE tenant_settings SET config = ? WHERE tenant_id = ?').run(JSON.stringify(config), tenantId);
    if (assignmentPeople !== undefined) db.prepare('UPDATE tenant_settings SET assignment_people = ? WHERE tenant_id = ?').run(JSON.stringify(assignmentPeople), tenantId);
  }
  function readState(tenantId: string, userKey: string): IssueState & { tenantId: string } {
    const result: IssueState & { tenantId: string } = { tenantId, userKey, bugs: [], updatedAt: '' };
    const stateRow = db.prepare('SELECT updated_at FROM user_states WHERE tenant_id = ? AND user_key = ?').get(tenantId, userKey) as unknown as { updated_at?: string } | undefined;
    result.updatedAt = stateRow?.updated_at || '';
    for (const row of db.prepare('SELECT payload FROM issue_items WHERE tenant_id = ? AND user_key = ? ORDER BY position').all(tenantId, userKey)) {
      result.bugs.push(JSON.parse(String(row.payload)) as WorkIssue);
    }
    return result;
  }
  function writeStateRows(tenantId: string, userKey: string, snapshot: unknown) {
    const normalized = normalizeIssueState(snapshot, userKey);
    // The database uses the exact key; legacy filesystem normalization is only used during import.
    db.prepare('INSERT INTO user_states VALUES (?, ?, ?) ON CONFLICT(tenant_id, user_key) DO UPDATE SET updated_at = excluded.updated_at')
      .run(tenantId, userKey, normalized.updatedAt);
    db.prepare('DELETE FROM issue_items WHERE tenant_id = ? AND user_key = ?').run(tenantId, userKey);
    const insert = db.prepare('INSERT INTO issue_items VALUES (?, ?, ?, ?, ?)');
    normalized.bugs.forEach((item, index) => insert.run(tenantId, userKey, String(item.id || `position-${index}`), index, JSON.stringify(item)));
  }
  function writeState(tenantId: string, userKey: string, snapshot: unknown) {
    transaction(() => writeStateRows(tenantId, userKey, snapshot));
  }
  function createStore(tenantId: string) {
    if (!getTenant(tenantId)) throw new Error('租户不存在');
    return {
      readUserState: (userKey: string) => readState(tenantId, userKey),
      writeUserState: async (userKey: string, snapshot: unknown) => writeState(tenantId, userKey, snapshot),
      // Commit synchronously, including background progress, so no cross-user debounce can drop writes.
      scheduleSave: (userKey: string, snapshot: unknown) => writeState(tenantId, userKey, snapshot),
      flushSave: async () => {},
    };
  }
  function importLegacy(rootDir: string, tenantId: string, defaults: Partial<TenantSettings> = {}) {
    const source = path.resolve(rootDir);
    if (db.prepare('SELECT 1 FROM imports WHERE tenant_id = ? AND source = ?').get(tenantId, source)) return { skipped: true, users: 0 };
    const readJson = (file: string, fallback: unknown = undefined): unknown => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
    const config = readJson(path.join(rootDir, '.workflow-config.json'), defaults.config || {});
    const people = readJson(path.join(rootDir, '.assignment-people.json'), defaults.assignmentPeople || []);
    const snapshots = new Map();
    for (const relative of ['.workflow-data/users', '.workflow-data/users/users']) {
      const dir = path.join(rootDir, relative);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name, 'state.json');
        if (entry.isDirectory() && existsSync(file)) {
          const snapshot = record(readJson(file));
          if (!Array.isArray(snapshot.bugs)) throw new Error(`旧数据格式不正确：${file}`);
          if (snapshots.has(entry.name)) throw new Error(`旧数据用户目录重复：${entry.name}，请先合并重复目录`);
          snapshots.set(entry.name, snapshot);
        }
      }
    }
    transaction(() => {
      if (db.prepare('SELECT 1 FROM user_states WHERE tenant_id = ? LIMIT 1').get(tenantId)) throw new Error('目标租户已有数据，拒绝覆盖；请迁移至空租户');
      writeSettings(tenantId, { config: record(config), assignmentPeople: Array.isArray(people) ? people : Array.isArray(record(people).people) ? record(people).people as unknown[] : [] });
      for (const [userKey, snapshot] of snapshots) writeStateRows(tenantId, userKey, snapshot);
      db.prepare('INSERT INTO imports VALUES (?, ?, ?)').run(tenantId, source, new Date().toISOString());
    });
    return { skipped: false, users: snapshots.size };
  }
  return {
    ...createIdentityStore(db, transaction),
    readSessionContext: (tenantId: string, id: string): SessionContext | null => {
      const row = db.prepare('SELECT payload FROM session_contexts WHERE tenant_id = ? AND id = ?').get(tenantId, id);
      return row ? JSON.parse(String(row.payload)) as SessionContext : null;
    },
    saveSessionContext: (tenantId: string, snapshot: SessionContext) => {
      db.prepare('INSERT INTO session_contexts VALUES (?, ?, ?) ON CONFLICT(tenant_id, id) DO NOTHING').run(tenantId, snapshot.id, JSON.stringify(snapshot));
    },
    readTaskCenter: (tenantId: string) => parseTaskCenter((db.prepare('SELECT payload FROM task_centers WHERE tenant_id = ?').get(tenantId) as { payload?: string } | undefined)?.payload),
    mutateTaskCenter: <T>(tenantId: string, update: (data: TaskCenterData) => T): T => transaction(() => {
      const data = parseTaskCenter((db.prepare('SELECT payload FROM task_centers WHERE tenant_id = ?').get(tenantId) as { payload?: string } | undefined)?.payload);
      const result = update(data);
      db.prepare('INSERT INTO task_centers VALUES (?, ?) ON CONFLICT(tenant_id) DO UPDATE SET payload = excluded.payload').run(tenantId, JSON.stringify(data));
      return result;
    }),
    createTenant, getTenant, authenticate, readSettings, writeSettings, createStore, importLegacy,
    listTenants: () => db.prepare('SELECT id, name, created_at AS createdAt FROM tenants ORDER BY id').all() as unknown as Tenant[],
    rotateToken: (id: string, token: string) => {
      if (!getTenant(id)) throw new Error('租户不存在');
      if (typeof token !== 'string' || token.length < 32) throw new Error('租户令牌至少需要 32 个字符');
      db.prepare('UPDATE tenants SET token_hash = ? WHERE id = ?').run(hashToken(token), id);
    },
    close: () => db.close()
  };
}
