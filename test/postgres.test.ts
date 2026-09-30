import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { databaseEnvironment, openDatabase, rawDatabase } from '../scripts/testing/database.js';
import { openDatabase as openApplicationDatabase } from '../src/database.js';
import { openPostgres, postgresConfig } from '../src/storage/postgres.js';

test('PostgreSQL initializes new schemas, upgrades version 1, preserves data and rejects future versions', () => {
  const key = randomUUID();
  const db = openDatabase(key);
  db.createTenant({ id: 'default', token: 'a'.repeat(43) });
  db.close();
  const raw = rawDatabase(key);
  raw.prepare('CREATE TABLE import_receipts (digest TEXT PRIMARY KEY)').run();
  raw.prepare('DELETE FROM schema_migrations WHERE version = 2').run();
  raw.close();
  const upgraded = openDatabase(key);
  assert.equal(upgraded.getTenant('default')?.id, 'default');
  upgraded.close();
  const check = rawDatabase(key);
  assert.equal(Number(check.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version), 2);
  assert.equal(check.prepare("SELECT to_regclass(current_schema() || '.import_receipts') AS table_name").get()?.table_name, null);
  check.prepare('INSERT INTO schema_migrations VALUES (999)').run();
  assert.throws(() => openDatabase(key), /PostgreSQL/);
  check.prepare('DELETE FROM schema_migrations WHERE version = 999').run();
  check.close();
});

test('PostgreSQL serializes competing processes and recovers from a terminated connection without retries', async () => {
  const key = randomUUID(), environment = databaseEnvironment(key);
  const db = openDatabase(key);
  db.createTenant({ id: 'default', token: 'b'.repeat(43) });
  db.writeSettings('default', { config: { count: 0 } });
  db.close();
  const increment = `
    import { openPostgres, postgresConfig } from './src/storage/postgres.ts';
    const db = openPostgres(postgresConfig(process.env));
    db.exec('BEGIN');
    const value = JSON.parse(db.prepare('SELECT config FROM tenant_settings WHERE tenant_id = ?').get('default').config);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    db.prepare('UPDATE tenant_settings SET config = ? WHERE tenant_id = ?').run(JSON.stringify({count: value.count + 1}), 'default');
    db.exec('COMMIT'); db.close();
  `;
  await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', increment], { env: { ...process.env, ...environment }, timeout: 20000 })));
  const raw = rawDatabase(key);
  assert.equal(JSON.parse(String(raw.prepare('SELECT config FROM tenant_settings WHERE tenant_id = ?').get('default')?.config)).count, 2);
  const doomed = rawDatabase(key), pid = Number(doomed.prepare('SELECT pg_backend_pid() AS pid').get()?.pid);
  const admin = new pg.Client(postgresConfig(environment));
  await admin.connect();
  try { await admin.query('SELECT pg_terminate_backend($1)', [pid]); } finally { await admin.end(); }
  assert.throws(() => doomed.prepare('SELECT 1').get(), /PostgreSQL/);
  assert.throws(() => doomed.prepare('SELECT 1').get(), /连接已关闭/);
  doomed.close();
  const recovered = rawDatabase(key);
  assert.equal(Number(recovered.prepare('SELECT 1 AS ok').get()?.ok), 1);
  recovered.close(); raw.close();
});

test('pgvector persists vectors, orders cosine neighbors, supports HNSW and filters tenants', () => {
  const key = randomUUID();
  let db = rawDatabase(key);
  db.prepare('CREATE TABLE vector_fixture (tenant_id TEXT, id TEXT, embedding vector(3))').run();
  db.prepare('INSERT INTO vector_fixture VALUES (?, ?, ?::vector), (?, ?, ?::vector), (?, ?, ?::vector)').run('a', 'near', '[1,0,0]', 'a', 'far', '[0,1,0]', 'b', 'private', '[1,0,0]');
  db.prepare('CREATE INDEX ON vector_fixture USING hnsw (embedding vector_cosine_ops)').run();
  db.close(); db = rawDatabase(key);
  assert.deepEqual(db.prepare('SELECT id FROM vector_fixture WHERE tenant_id = ? ORDER BY embedding <=> ?::vector LIMIT 2').all('a', '[1,0,0]').map(row => row.id), ['near', 'far']);
  assert.equal(Number(db.prepare("SELECT '[1,0,0]'::vector <=> '[0,1,0]'::vector AS distance").get()?.distance), 1);
  db.close();
});

test('database rejects missing configuration and unsupported drivers', () => {
  assert.throws(() => openApplicationDatabase({}), /配置不完整/);
  assert.throws(() => openApplicationDatabase({ DATABASE_DRIVER: 'other' }), /仅支持 postgres/);
  assert.throws(() => postgresConfig({ PGHOST: 'localhost', PGUSER: 'user', PGPASSWORD: 'test', PGDATABASE: 'workflow_test', PGSCHEMA: 'invalid;schema' }), /PGSCHEMA/);
});
