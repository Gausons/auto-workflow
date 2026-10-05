import { workerData, type MessagePort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { PostgresConfig } from './postgres.js';
import type { SqlValue, SqlRow } from './connection.js';

const { config, port, signal } = workerData as { config: PostgresConfig; port: MessagePort; signal: Int32Array };
let client: pg.Client | undefined;
let transaction = false;
let broken = false;
// Only SQL authored by the application enters this adapter. Preserve literals while
// converting positional parameters and quoting camelCase result aliases.
export function postgresSql(sql: string) {
  let index = 0;
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?|\bAS\s+([a-zA-Z_][a-zA-Z_0-9]*)/gi, (match, alias: string | undefined) => {
    if (match === '?') return `$${++index}`;
    return alias ? `AS "${alias}"` : match;
  });
}
function number(value: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('INTEGER_OUT_OF_RANGE');
  return result;
}
async function initialize() {
  client = new pg.Client({ ...config, connectionTimeoutMillis: 10000, statement_timeout: 20000,
    types: { getTypeParser: (oid, format) => oid === 20 ? number : pg.types.getTypeParser(oid, format) } });
  client.on('error', () => { broken = true; });
  await client.connect();
  await client.query("SET lock_timeout = '10s'");
  const extension = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
  if (!extension.rowCount) throw new Error('PGVECTOR_NOT_INSTALLED');
  if (config.initializeSchema === false) return;
  const schema = config.schema || 'public';
  if (config.schema) await client.query(`SET search_path TO "${config.schema}", public`);
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(710042, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS "${schema}".schema_migrations (version INT PRIMARY KEY)`);
    const versions = await client.query(`SELECT MAX(version) AS version FROM "${schema}".schema_migrations`);
    const version = Number(versions.rows[0].version || 0);
    if (version > 4) throw new Error('SCHEMA_VERSION_UNSUPPORTED');
    if (!version) {
      await client.query(readFileSync(new URL('../../migrations/postgres/001_initial.sql', import.meta.url), 'utf8').replaceAll('CREATE TABLE IF NOT EXISTS ', `CREATE TABLE IF NOT EXISTS "${schema}".`));
      await client.query(`INSERT INTO "${schema}".schema_migrations VALUES (1)`);
    }
    if (version < 2) {
      await client.query(readFileSync(new URL('../../migrations/postgres/002_remove_import_receipts.sql', import.meta.url), 'utf8'));
      await client.query(`INSERT INTO "${schema}".schema_migrations VALUES (2)`);
    }
    if (version < 3) {
      await client.query(readFileSync(new URL('../../migrations/postgres/003_remote_session_history.sql', import.meta.url), 'utf8'));
      await client.query(`INSERT INTO "${schema}".schema_migrations VALUES (3)`);
    }
    if (version < 4) {
      await client.query(readFileSync(new URL('../../migrations/postgres/004_remote_session_images.sql', import.meta.url), 'utf8'));
      await client.query(`INSERT INTO "${schema}".schema_migrations VALUES (4)`);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function begin() {
  await client!.query('BEGIN');
  try { await client!.query('SELECT pg_advisory_xact_lock(710042, 2)'); }
  catch (error) { await client!.query('ROLLBACK'); throw error; }
  transaction = true;
}
async function execute(operation: string, sql: string, params: SqlValue[]) {
  if (operation === 'initialize') { await initialize(); return null; }
  if (!client || broken) throw new Error('CONNECTION_UNAVAILABLE');
  if (operation === 'close') { await client.end(); return null; }
  if (operation === 'exec') {
    if (sql === 'BEGIN') { await begin(); return null; }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') { await client.query(sql); transaction = false; return null; }
    throw new Error('UNSUPPORTED_EXEC');
  }
  const autoWrite = !transaction && /^(INSERT|UPDATE|DELETE)\b/i.test(sql.trim());
  if (autoWrite) await begin();
  try {
    const result = await client.query(postgresSql(sql), params.map((value) => value instanceof Uint8Array ? Buffer.from(value) : value));
    if (autoWrite) { await client.query('COMMIT'); transaction = false; }
    return (result.rows as Record<string, unknown>[]).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'boolean' ? Number(value) : value])) as SqlRow);
  } catch (error) {
    if (autoWrite) { await client.query('ROLLBACK'); transaction = false; }
    throw error;
  }
}
port.on('message', async ({ operation, sql, params }: { operation: string; sql: string; params: SqlValue[] }) => {
  try { port.postMessage({ result: await execute(operation, sql, params) }); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'DATABASE_OPERATION_FAILED';
    const fatal = broken || operation === 'initialize' || operation === 'exec' && sql === 'COMMIT' || !/^[0-9A-Z]{5}$/.test(code) || /^(08|57)/.test(code);
    if (fatal) { broken = true; void client?.end(); }
    port.postMessage({ error: `PostgreSQL 操作失败（${code}）${fatal ? '，连接已关闭，请核对操作结果' : ''}`, fatal });
  } finally { Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); }
});
