import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { openMysql, mysqlConfig } from '../src/storage/mysql.js';
import { importSqlite, importTables } from '../src/storage/import-sqlite.js';
import { createApp } from '../server.js';
import { freezeSnapshot } from '@auto-workflow/context-engine';

const enabled = process.env.MYSQL_TEST === '1';
const environment = { ...process.env, DATABASE_DRIVER: 'mysql' };
const password = 'mysql-test-password-2026';

test('MySQL imports SQLite atomically and preserves tenant, auth, binary, rollback and restart behavior', { skip: !enabled }, async () => {
  const config = mysqlConfig(environment);
  // This guard prevents a developer accidentally pointing destructive test cleanup at production.
  assert.match(config.database, /^workflow_test(?:_[a-z0-9]+)?$/);
  const raw = openMysql(config);
  const clear = () => { for (const table of [...importTables].reverse()) raw.prepare(`DELETE FROM ${table}`).run(); raw.prepare('DELETE FROM sqlite_imports').run(); };
  clear();
  const root = await mkdtemp(path.join(tmpdir(), 'workflow-mysql-'));
  const filename = path.join(root, 'legacy.sqlite');
  const sqlite = openDatabase(filename);
  const image = Buffer.alloc(100000, 27), digest = createHash('sha256').update(image).digest('hex');
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    sqlite.createTenant({ id: 'default', token: 'a'.repeat(43) });
    sqlite.createTenant({ id: 'other', token: 'b'.repeat(43) });
    sqlite.importLegacy(root, 'default');
    const owner = await sqlite.createUser('default', { username: 'owner', password }, { bootstrap: true });
    const session = await sqlite.login('default', 'owner', password);
    sqlite.loginWithGoogle({ subject: 'google-fixture', email: 'fixture@example.com', displayName: '测试' });
    sqlite.createStore('default').scheduleSave('person', { bugs: [{ id: 'bug', title: '迁移中文🙂' }] });
    sqlite.saveContextObject('default', 'binary', digest, 'image/png', image);
    const snapshot = freezeSnapshot([{ role: 'user', text: '交接上下文', source: 's' }], ['s']);
    sqlite.recordContextTransfer('default', 'transfer', 'device-a', 'device-b', snapshot);
    sqlite.mutateTaskCenter('default', (data) => { data.sessions = []; });
    sqlite.close();
    assert.equal(importSqlite(filename, config).skipped, false);
    assert.equal(importSqlite(filename, config).skipped, true);
    db = openDatabase(filename, environment);
    assert.equal(db.authenticateSession(session.token)?.user.id, owner.id);
    assert.equal(db.getUser('other', owner.id), undefined);
    assert.equal(db.authenticateSession('unknown'), null);
    assert.equal(db.authenticate('unknown'), null);
    assert.equal(db.createStore('default').readUserState('person').bugs[0].title, '迁移中文🙂');
    assert.deepEqual(Buffer.from(db.readContextObject('default', 'binary', digest)!.bytes), image);
    assert.equal(db.readContextObject('other', 'binary', digest), null);
    assert.equal(db.readContextTransfer('default', 'transfer')?.snapshotDigest, snapshot.digest);
    db.recordContextTransferFailure('default', 'retry', 'a', 'b', snapshot.id, snapshot.digest, '失败');
    db.recordContextTransferFailure('default', 'retry', 'a', 'b', snapshot.id, snapshot.digest, '再次失败');
    assert.equal(db.readContextTransfer('default', 'retry')?.revision, 2);
    const store = db.createStore('default');
    await assert.rejects(store.writeUserState('person', { bugs: [{ id: 'duplicate' }, { id: 'duplicate' }] }));
    assert.equal(store.readUserState('person').bugs[0].title, '迁移中文🙂');
    for (const key of ['Case', 'case', 'case ']) store.scheduleSave(key, { bugs: [{ id: 'same', title: key }] });
    for (const key of ['Case', 'case', 'case ']) assert.equal(store.readUserState(key).bugs[0].title, key);
    const concurrentDb = openDatabase(filename, environment);
    const competing = await Promise.allSettled([db, concurrentDb].map((connection) => connection.createUser('default', { username: 'viewer', password, role: 'viewer' }, { actor: owner })));
    concurrentDb.close();
    assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
    const viewer = db.listUsers('default').find((user) => user.username === 'viewer')!;
    await assert.rejects(db.createUser('default', { username: 'forbidden', password }, { actor: viewer }), /权限/);
    const viewerSession = await db.login('default', 'viewer', password);
    db.updateUser('default', viewer.id, { enabled: false }, owner);
    assert.equal(db.authenticateSession(viewerSession.token), null);
    db.close(); db = openDatabase(filename, environment);
    assert.equal(db.authenticateSession(session.token)?.user.id, owner.id);
    assert.equal(db.listUsers('default').length, 2);
    // A different source must never overwrite an already populated target.
    const changed = openDatabase(filename); changed.writeSettings('default', { config: { changed: true } }); changed.close();
    assert.throws(() => importSqlite(filename, config), /非空/);
    db.close(); db = undefined;
    const app = createApp({ rootDir: root, environment: { ...environment, ACP_ENABLED: 'false', CODEX_EXECUTABLE: '/nonexistent/codex' } });
    try {
      app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
      const address = app.server.address(); assert.ok(address && typeof address === 'object');
      const base = `http://127.0.0.1:${address.port}`;
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
      assert.equal((await fetch(`${base}/api/task-center`)).status, 401);
      assert.equal((await fetch(`${base}/api/task-center`, { headers: { Authorization: `Bearer ${session.token}`, 'x-tenant-id': 'other' } })).status, 403);
      assert.equal((await fetch(`${base}/api/not-a-route`, { headers: { Authorization: `Bearer ${session.token}` } })).status, 404);
    } finally { await app.close(); }
    raw.prepare('UPDATE tenant_settings SET config = ? WHERE tenant_id = ?').run('{"count":0}', 'default');
    const increment = `
      import { openMysql, mysqlConfig } from './src/storage/mysql.ts';
      const connection = openMysql(mysqlConfig(process.env));
      connection.exec('BEGIN IMMEDIATE');
      const value = JSON.parse(connection.prepare('SELECT config FROM tenant_settings WHERE tenant_id = ?').get('default').config);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      connection.prepare('UPDATE tenant_settings SET config = ? WHERE tenant_id = ?').run(JSON.stringify({count: value.count + 1}), 'default');
      connection.exec('COMMIT'); connection.close();
    `;
    await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', increment], { env: environment, timeout: 15000 })));
    assert.equal(JSON.parse(String(raw.prepare('SELECT config FROM tenant_settings WHERE tenant_id = ?').get('default')?.config)).count, 2);
    clear();
    const invalid = openDatabase(filename);
    invalid.createStore('default').scheduleSave('x'.repeat(257), { bugs: [] });
    invalid.close();
    assert.throws(() => importSqlite(filename, config), /MySQL 操作失败/);
    assert.equal(Number(raw.prepare('SELECT COUNT(*) AS count FROM tenants').get()?.count), 0);
    const doomed = openMysql(config);
    const id = Number(doomed.prepare('SELECT CONNECTION_ID() AS id').get()?.id);
    const administrator = await mysql.createConnection(config);
    await administrator.query(`KILL CONNECTION ${id}`);
    await administrator.end();
    assert.throws(() => doomed.prepare('SELECT 1').get(), /MySQL/);
    assert.throws(() => doomed.prepare('SELECT 1').get(), /连接已关闭/);
    doomed.close();
    const recovered = openMysql(config);
    assert.equal(Number(recovered.prepare('SELECT 1 AS ok').get()?.ok), 1);
    recovered.close();
  } finally { db?.close(); clear(); raw.close(); await rm(root, { recursive: true, force: true }); }
});

test('MySQL refuses incomplete configuration and unknown drivers instead of silently falling back', () => {
  assert.throws(() => openDatabase(':memory:', { DATABASE_DRIVER: 'mysql' }), /配置不完整/);
  assert.throws(() => openDatabase(':memory:', { DATABASE_DRIVER: 'other' }), /仅支持/);
});
