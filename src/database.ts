// @ts-nocheck
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createExecutionRecord, normalizeStoredState } from './workflowStore.js';
import { createIdentityStore } from './identity.js';

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 3) { db.close(); throw new Error('数据库版本高于当前程序支持的版本'); }
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

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function createTenant({ id, name = id, token }) {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(id)) throw new Error('租户 ID 仅支持小写字母、数字、下划线和短横线，最多 63 个字符');
    if (typeof token !== 'string' || token.length < 32) throw new Error('租户令牌至少需要 32 个字符');
    transaction(() => {
      db.prepare('INSERT INTO tenants VALUES (?, ?, ?, ?)').run(id, name, hashToken(token), new Date().toISOString());
      db.prepare('INSERT INTO tenant_settings(tenant_id) VALUES (?)').run(id);
    });
    return getTenant(id);
  }
  function getTenant(id) {
    return db.prepare('SELECT id, name, created_at AS createdAt FROM tenants WHERE id = ?').get(id);
  }
  function authenticate(token) {
    if (!token || token.length > 512) return null;
    return db.prepare('SELECT id, name, created_at AS createdAt FROM tenants WHERE token_hash = ?').get(hashToken(token)) || null;
  }
  function readSettings(tenantId) {
    const row = db.prepare('SELECT config, assignment_people FROM tenant_settings WHERE tenant_id = ?').get(tenantId);
    if (!row) throw new Error('租户不存在');
    return { config: JSON.parse(row.config), assignmentPeople: JSON.parse(row.assignment_people) };
  }
  function writeSettings(tenantId, { config, assignmentPeople }) {
    if (config !== undefined) db.prepare('UPDATE tenant_settings SET config = ? WHERE tenant_id = ?').run(JSON.stringify(config), tenantId);
    if (assignmentPeople !== undefined) db.prepare('UPDATE tenant_settings SET assignment_people = ? WHERE tenant_id = ?').run(JSON.stringify(assignmentPeople), tenantId);
  }
  function readState(tenantId, userKey) {
    const result = { tenantId, userKey, bugs: [], runs: [], executionRecords: [] };
    result.updatedAt = db.prepare('SELECT updated_at FROM user_states WHERE tenant_id = ? AND user_key = ?').get(tenantId, userKey)?.updated_at || null;
    for (const row of db.prepare('SELECT kind, payload FROM workflow_items WHERE tenant_id = ? AND user_key = ? ORDER BY position').all(tenantId, userKey)) {
      result[row.kind].push(JSON.parse(row.payload));
    }
    return result;
  }
  function writeStateRows(tenantId, userKey, snapshot) {
    const normalized = normalizeStoredState(snapshot, userKey);
    // The database uses the exact key; legacy filesystem normalization is only used during import.
    db.prepare('INSERT INTO user_states VALUES (?, ?, ?) ON CONFLICT(tenant_id, user_key) DO UPDATE SET updated_at = excluded.updated_at')
      .run(tenantId, userKey, normalized.updatedAt);
    db.prepare('DELETE FROM workflow_items WHERE tenant_id = ? AND user_key = ?').run(tenantId, userKey);
    const insert = db.prepare('INSERT INTO workflow_items VALUES (?, ?, ?, ?, ?, ?)');
    for (const kind of ['bugs', 'runs', 'executionRecords']) {
      normalized[kind].forEach((item, index) => insert.run(tenantId, userKey, kind, String(item.id || `position-${index}`), index, JSON.stringify(item)));
    }
  }
  function writeState(tenantId, userKey, snapshot) {
    transaction(() => writeStateRows(tenantId, userKey, snapshot));
  }
  function createStore(tenantId) {
    if (!getTenant(tenantId)) throw new Error('租户不存在');
    return {
      readUserState: (userKey) => readState(tenantId, userKey),
      writeUserState: async (userKey, snapshot) => writeState(tenantId, userKey, snapshot),
      // Commit synchronously, including background progress, so no cross-user debounce can drop writes.
      scheduleSave: (userKey, snapshot) => writeState(tenantId, userKey, snapshot),
      flushSave: async () => {},
      appendExecutionRecord: (records, record) => [createExecutionRecord(record), ...records].slice(0, 500)
    };
  }
  function importLegacy(rootDir, tenantId, defaults = {}) {
    const source = path.resolve(rootDir);
    if (db.prepare('SELECT 1 FROM imports WHERE tenant_id = ? AND source = ?').get(tenantId, source)) return { skipped: true, users: 0 };
    const readJson = (file, fallback) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
    const config = readJson(path.join(rootDir, '.workflow-config.json'), defaults.config || {});
    const people = readJson(path.join(rootDir, '.assignment-people.json'), defaults.assignmentPeople || []);
    const snapshots = new Map();
    for (const relative of ['.workflow-data/users', '.workflow-data/users/users']) {
      const dir = path.join(rootDir, relative);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name, 'state.json');
        if (entry.isDirectory() && existsSync(file)) {
          const snapshot = readJson(file);
          if (!Array.isArray(snapshot.bugs) || !Array.isArray(snapshot.runs)) throw new Error(`旧数据格式不正确：${file}`);
          if (snapshots.has(entry.name)) throw new Error(`旧数据用户目录重复：${entry.name}，请先合并重复目录`);
          snapshots.set(entry.name, snapshot);
        }
      }
    }
    transaction(() => {
      if (db.prepare('SELECT 1 FROM user_states WHERE tenant_id = ? LIMIT 1').get(tenantId)) throw new Error('目标租户已有数据，拒绝覆盖；请迁移至空租户');
      writeSettings(tenantId, { config, assignmentPeople: Array.isArray(people) ? people : people.people });
      for (const [userKey, snapshot] of snapshots) writeStateRows(tenantId, userKey, snapshot);
      db.prepare('INSERT INTO imports VALUES (?, ?, ?)').run(tenantId, source, new Date().toISOString());
    });
    return { skipped: false, users: snapshots.size };
  }
  return {
    ...createIdentityStore(db, transaction),
    readTaskCenter: (tenantId) => JSON.parse(db.prepare('SELECT payload FROM task_centers WHERE tenant_id = ?').get(tenantId)?.payload || '{"tasks":[],"devices":[],"sessions":[],"handoffs":[]}'),
    mutateTaskCenter: (tenantId, update) => transaction(() => {
      const data = JSON.parse(db.prepare('SELECT payload FROM task_centers WHERE tenant_id = ?').get(tenantId)?.payload || '{"tasks":[],"devices":[],"sessions":[],"handoffs":[]}');
      const result = update(data);
      db.prepare('INSERT INTO task_centers VALUES (?, ?) ON CONFLICT(tenant_id) DO UPDATE SET payload = excluded.payload').run(tenantId, JSON.stringify(data));
      return result;
    }),
    createTenant, getTenant, authenticate, readSettings, writeSettings, createStore, importLegacy,
    listTenants: () => db.prepare('SELECT id, name, created_at AS createdAt FROM tenants ORDER BY id').all(),
    rotateToken: (id, token) => {
      if (!getTenant(id)) throw new Error('租户不存在');
      if (typeof token !== 'string' || token.length < 32) throw new Error('租户令牌至少需要 32 个字符');
      db.prepare('UPDATE tenants SET token_hash = ? WHERE id = ?').run(hashToken(token), id);
    },
    close: () => db.close()
  };
}
