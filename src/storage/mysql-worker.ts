import { workerData, type MessagePort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import type { MysqlConfig } from './mysql.js';
import type { SqlValue } from './connection.js';

const { config, port, signal } = workerData as { config: MysqlConfig; port: MessagePort; signal: Int32Array };
let connection: Connection | undefined;
let transaction = false;
let broken = false;
function translate(sql: string) {
  return sql
    .replace('ON CONFLICT(tenant_id, user_key) DO UPDATE SET updated_at = excluded.updated_at', 'ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)')
    .replace('ON CONFLICT(tenant_id, id) DO NOTHING', 'ON DUPLICATE KEY UPDATE id = session_contexts.id')
    .replace('ON CONFLICT(tenant_id, execution_id) DO UPDATE SET failure = excluded.failure, revision = context_transfers.revision + 1, updated_at = excluded.updated_at', 'ON DUPLICATE KEY UPDATE failure = VALUES(failure), revision = context_transfers.revision + 1, updated_at = VALUES(updated_at)')
    .replace('ON CONFLICT(tenant_id) DO UPDATE SET payload = excluded.payload', 'ON DUPLICATE KEY UPDATE payload = VALUES(payload)');
}
async function initialize() {
  connection = await mysql.createConnection({ ...config, charset: 'utf8mb4', connectTimeout: 10000, supportBigNumbers: true });
  await connection.query('SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin');
  connection.on('error', () => { broken = true; });
  await connection.query("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION', innodb_lock_wait_timeout = 10");
  const lock = 'workflow-schema-' + createHash('sha256').update(config.database).digest('hex').slice(0, 40);
  const [rows] = await connection.execute<RowDataPacket[]>('SELECT GET_LOCK(?, 10) AS acquired', [lock]);
  if (Number(rows[0].acquired) !== 1) throw new Error('SCHEMA_LOCK_TIMEOUT');
  try {
    await connection.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY) ENGINE=InnoDB');
    const [versions] = await connection.query<RowDataPacket[]>('SELECT MAX(version) AS version FROM schema_migrations');
    const version = Number(versions[0].version || 0);
    if (version > 1) throw new Error('SCHEMA_VERSION_UNSUPPORTED');
    if (version === 0) {
      const schema = readFileSync(new URL('../../migrations/mysql/001_initial.sql', import.meta.url), 'utf8');
      for (const statement of schema.split(';').map((s) => s.trim()).filter(Boolean)) await connection.query(statement);
      await connection.query('INSERT INTO schema_migrations VALUES (1)');
    }
  } finally { await connection.execute('SELECT RELEASE_LOCK(?)', [lock]); }
}
async function begin() {
  await connection!.beginTransaction();
  try { await connection!.query('SELECT id FROM write_lock WHERE id = 1 FOR UPDATE'); }
  catch (error) { await connection!.rollback(); throw error; }
  transaction = true;
}
async function execute(operation: string, sql: string, params: SqlValue[]) {
  if (operation === 'initialize') { await initialize(); return null; }
  if (!connection || broken) throw new Error('CONNECTION_UNAVAILABLE');
  if (operation === 'close') { await connection.end(); return null; }
  if (operation === 'exec') {
    if (sql === 'BEGIN IMMEDIATE') { await begin(); return null; }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') {
      await connection.query(sql); transaction = false; return null;
    }
    throw new Error('UNSUPPORTED_EXEC');
  }
  const autocommitWrite = !transaction && /^(INSERT|UPDATE|DELETE)\b/i.test(sql.trim());
  if (autocommitWrite) await begin();
  try {
    const [result] = await connection.execute(translate(sql), params.map((value) => value instanceof Uint8Array ? Buffer.from(value) : value));
    if (autocommitWrite) { await connection.commit(); transaction = false; }
    return result;
  } catch (error) {
    if (autocommitWrite) { await connection.rollback(); transaction = false; }
    throw error;
  }
}
port.on('message', async ({ operation, sql, params }: { operation: string; sql: string; params: SqlValue[] }) => {
  try { port.postMessage({ result: await execute(operation, sql, params) }); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'DATABASE_OPERATION_FAILED';
    const fatal = broken || operation === 'initialize' || operation === 'exec' && sql === 'COMMIT' || !code.startsWith('ER_');
    if (fatal) { broken = true; connection?.destroy(); }
    port.postMessage({ error: `MySQL 操作失败（${code}）${fatal ? '，连接已关闭，请核对操作结果' : ''}`, fatal });
  } finally { Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); }
});
