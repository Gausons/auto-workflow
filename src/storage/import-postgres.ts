import { createHash } from 'node:crypto';
import { openMysql, type MysqlConfig } from './mysql.js';
import { openPostgres, type PostgresConfig } from './postgres.js';
import { importTables } from './import-sqlite.js';
import type { Connection, SqlRow } from './connection.js';

function canonical(rows: SqlRow[]) {
  return rows.map((row) => JSON.stringify(Object.keys(row).sort().map((key) => [key, row[key] instanceof Uint8Array ? { bytes: Buffer.from(row[key]).toString('base64') } : row[key]]))).sort();
}
// Stop every source writer first. Hold the existing writer lock for a consistent snapshot.
export function importMysqlToPostgres(sourceConfig: MysqlConfig, targetConfig: PostgresConfig) {
  const source = openMysql(sourceConfig);
  let target: Connection | undefined;
  try {
    target = openPostgres(targetConfig);
    source.exec('BEGIN IMMEDIATE');
    const tables = importTables.map((table) => ({ table, rows: source.prepare(`SELECT * FROM ${table}`).all() }));
    const digest = createHash('sha256').update(JSON.stringify(tables.map(({ table, rows }) => [table, canonical(rows)]))).digest('hex');
    target.exec('BEGIN IMMEDIATE');
    try {
      if (target.prepare('SELECT digest FROM import_receipts WHERE digest = ?').get(digest)) {
        target.exec('COMMIT'); return { skipped: true, counts: {} };
      }
      for (const { table } of tables) if (Number(target.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count)) throw new Error('PostgreSQL 目标库非空，拒绝覆盖现有数据');
      for (const { table, rows } of tables) {
        for (const row of rows) {
          const columns = Object.keys(row);
          if (columns.some((column) => !/^[a-z_]+$/.test(column))) throw new Error('源数据库列名无效');
          target.prepare(`INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map((column) => row[column]));
        }
        if (JSON.stringify(canonical(rows)) !== JSON.stringify(canonical(target.prepare(`SELECT * FROM ${table}`).all()))) throw new Error(`迁移校验失败：${table}`);
      }
      // Imported explicit IDs do not advance a PostgreSQL identity sequence.
      target.prepare("SELECT setval(pg_get_serial_sequence('audit_events', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM audit_events").get();
      target.prepare('INSERT INTO import_receipts VALUES (?, ?)').run(digest, new Date().toISOString());
      target.exec('COMMIT');
      return { skipped: false, counts: Object.fromEntries(tables.map(({ table, rows }) => [table, rows.length])) };
    } catch (error) { try { target.exec('ROLLBACK'); } catch { /* Preserve uncertain commit failures. */ } throw error; }
  } finally { source.close(); target?.close(); }
}
