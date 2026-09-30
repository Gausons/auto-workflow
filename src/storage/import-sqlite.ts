import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openMysql, type MysqlConfig } from './mysql.js';
import type { Connection, SqlRow } from './connection.js';

export const importTables = ['tenants', 'tenant_settings', 'user_states', 'issue_items', 'imports', 'organization_users', 'user_sessions', 'audit_events', 'task_centers', 'session_contexts', 'context_transfers', 'context_transfer_objects', 'context_transfer_manifests', 'auth_identities'] as const;
function canonical(rows: SqlRow[]) {
  return rows.map((row) => JSON.stringify(Object.keys(row).sort().map((key) => [key, row[key] instanceof Uint8Array ? { bytes: Buffer.from(row[key]).toString('base64') } : row[key]]))).sort();
}

// The application must be stopped; source is never changed and target must be empty.
export function importSqlite(filename: string, config: MysqlConfig) {
  const source = new DatabaseSync(filename, { readOnly: true });
  let target: Connection | undefined;
  try {
    target = openMysql(config);
    source.exec('BEGIN');
    if (Number(source.prepare('PRAGMA user_version').get()?.user_version) !== 8) throw new Error('请先用 SQLite 模式将旧库升级到版本 8');
    if (source.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || source.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite 完整性检查失败');
    const tables = importTables.map((table) => ({ table, rows: source.prepare(`SELECT * FROM ${table}`).all() }));
    const digest = createHash('sha256').update(JSON.stringify(tables.map(({ table, rows }) => [table, canonical(rows)]))).digest('hex');
    target.exec('BEGIN IMMEDIATE');
    try {
      if (target.prepare('SELECT digest FROM sqlite_imports WHERE digest = ?').get(digest)) {
        target.exec('COMMIT'); return { skipped: true, counts: {} };
      }
      for (const { table } of tables) if (Number(target.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count)) throw new Error('MySQL 目标库非空，拒绝覆盖现有数据');
      for (const { table, rows } of tables) {
        for (const row of rows) {
          const columns = Object.keys(row);
          // Identifiers come exclusively from our validated SQLite schema, never caller input.
          if (columns.some((column) => !/^[a-z_]+$/.test(column))) throw new Error('SQLite 列名无效');
          target.prepare(`INSERT INTO ${table} (${columns.map((column) => `\`${column}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map((column) => row[column]));
        }
        if (JSON.stringify(canonical(rows)) !== JSON.stringify(canonical(target.prepare(`SELECT * FROM ${table}`).all()))) throw new Error(`迁移校验失败：${table}`);
      }
      target.prepare('INSERT INTO sqlite_imports VALUES (?, ?)').run(digest, new Date().toISOString());
      target.exec('COMMIT');
      return { skipped: false, counts: Object.fromEntries(tables.map(({ table, rows }) => [table, rows.length])) };
    } catch (error) { try { target.exec('ROLLBACK'); } catch { /* Preserve uncertain commit failures. */ } throw error; }
  } finally { source.close(); target?.close(); }
}
