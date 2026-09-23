import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.js';
import { hashToken, openDatabase } from '../src/database.js';

const setupToken = 'setup-token-'.repeat(4);
const password = 'correct-member-password';
interface ApiUser { id: string; role: string; password_hash?: string; username?: string }
interface AuditEvent { action: string; actorName?: string }
interface ApiData {
  token?: string; user?: ApiUser; permissions?: string[]; members?: ApiUser[]; events?: AuditEvent[];
  config?: { assignee?: string }; [key: string]: unknown;
}
interface LoginData extends ApiData { token: string; user: ApiUser; permissions: string[] }

test('organization members, role enforcement, cross-organization access and immediate session revocation', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'bugflow-rbac-'));
  const app = createApp({ rootDir, environment: { DEFAULT_TENANT_TOKEN: setupToken } });
  try {
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const request = async (token: string | null, endpoint: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() as ApiData };
    };
    const login = async (username: string, userPassword = password, tenantId = 'default'): Promise<LoginData> => {
      const result = await request(null, '/api/auth/login', 'POST', { tenantId, username, password: userPassword });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.ok(result.data.token && result.data.user && result.data.permissions);
      return result.data as LoginData;
    };
    assert.equal((await request(setupToken, '/api/bootstrap')).status, 401);
    const competing = await Promise.all(['owner', 'other-owner'].map((username) => request(setupToken, '/api/auth/setup', 'POST', { username, password })));
    assert.deepEqual(competing.map((result) => result.status).sort(), [201, 409]);
    const winner = competing[0].status === 201 ? 'owner' : 'other-owner';
    let owner = await login(winner);
    assert.equal(owner.user.role, 'owner');
    assert.ok(owner.permissions.includes('members.manage'));
    assert.equal((await request(setupToken, '/api/auth/setup')).status, 409);
    assert.equal((await request(setupToken, '/api/config', 'PUT', { assignee: 'bypass' })).status, 401);
    const users: Record<string, LoginData> = {};
    for (const role of ['admin', 'operator', 'viewer']) {
      const created = await request(owner.token, '/api/organization/members', 'POST', { username: role, password, role });
      assert.equal(created.status, 201);
      assert.equal(created.data.user?.password_hash, undefined);
      users[role] = await login(role);
    }
    const viewer = users.viewer, admin = users.admin, operator = users.operator;
    assert.equal((await request(viewer.token, '/api/bootstrap')).status, 200);
    assert.equal((await request(viewer.token, '/api/task-center')).status, 200);
    for (const [method, endpoint] of [
      ['PUT', '/api/config'], ['PUT', '/api/assignment/people'], ['POST', '/api/sync'], ['GET', '/api/issues/diagnostics'],
      ['POST', '/api/scheduler'], ['POST', '/api/bugs/x/task'],
      ['POST', '/api/bugs/x/assignment/apply'], ['POST', '/api/bugs/x/assignment/recommend'],
      ['POST', '/api/assignments/apply-all'],
      ['GET', '/api/organization/members'], ['POST', '/api/organization/members'], ['GET', '/api/organization/audit']
    ]) assert.equal((await request(viewer.token, endpoint, method, method === 'GET' ? undefined : { role: 'owner', tenantId: 'other' })).status, 403, endpoint);
    assert.equal((await request(operator.token, '/api/bugs/not-found/task', 'POST', {})).status, 404);
    for (const endpoint of ['/api/config', '/api/organization/members']) {
      assert.equal((await request(operator.token, endpoint, endpoint === '/api/config' ? 'PUT' : 'POST', {})).status, 403);
    }
    assert.equal((await request(admin.token, '/api/config', 'PUT', { assignee: 'admin-assignee' })).status, 200);
    assert.equal((await request(admin.token, '/api/organization/members', 'POST', { username: 'escalate', role: 'owner', password })).status, 403);
    assert.equal((await request(admin.token, `/api/organization/members/${admin.user.id}`, 'PATCH', { role: 'owner' })).status, 403);
    assert.equal((await request(admin.token, `/api/organization/members/${owner.user.id}`, 'PUT', {})).status, 404);
    assert.equal((await request(admin.token, `/api/organization/members/${owner.user.id}/password`, 'PUT', { password })).status, 403);
    assert.equal((await request(owner.token, `/api/organization/members/${owner.user.id}`, 'PATCH', { enabled: false })).status, 409);
    assert.equal((await request(owner.token, `/api/organization/members/${owner.user.id}`, 'PATCH', { role: 'viewer' })).status, 409);
    assert.equal((await request(owner.token, `/api/organization/members/${viewer.user.id}`, 'PATCH', { role: 'superuser' })).status, 400);
    assert.equal((await request(owner.token, '/api/organization/members', 'POST', { username: 'viewer', password, role: 'viewer' })).status, 409);

    // A live token follows role changes without requiring another login.
    assert.equal((await request(admin.token, `/api/organization/members/${viewer.user.id}`, 'PATCH', { role: 'operator' })).status, 200);
    assert.equal((await request(viewer.token, '/api/bugs/missing/task', 'POST', {})).status, 404);
    await request(admin.token, `/api/organization/members/${viewer.user.id}`, 'PATCH', { role: 'viewer' });
    assert.equal((await request(viewer.token, '/api/bugs/missing/task', 'POST', {})).status, 403);
    await request(admin.token, `/api/organization/members/${viewer.user.id}`, 'PATCH', { enabled: false });
    assert.equal((await request(viewer.token, '/api/bootstrap')).status, 401);
    assert.equal((await request(null, '/api/auth/login', 'POST', { tenantId: 'default', username: 'viewer', password })).status, 401);
    await request(admin.token, `/api/organization/members/${viewer.user.id}`, 'PATCH', { enabled: true });
    assert.equal((await request(viewer.token, '/api/bootstrap')).status, 401);

    const secondOperatorSession = await login('operator');
    await request(admin.token, `/api/organization/members/${operator.user.id}/password`, 'PUT', { password: 'replacement-password' });
    assert.equal((await request(operator.token, '/api/bootstrap')).status, 401);
    assert.equal((await request(secondOperatorSession.token, '/api/bootstrap')).status, 401);
    const resetOperator = await login('operator', 'replacement-password');
    assert.equal((await request(resetOperator.token, '/api/auth/password', 'PUT', { currentPassword: 'wrong', password })).status, 400);
    assert.equal((await request(resetOperator.token, '/api/auth/password', 'PUT', { currentPassword: 'replacement-password', password })).status, 200);
    assert.equal((await request(resetOperator.token, '/api/bootstrap')).status, 401);
    const loggedOut = await login('operator');
    await request(loggedOut.token, '/api/auth/logout', 'POST');
    assert.equal((await request(loggedOut.token, '/api/bootstrap')).status, 401);

    const db = openDatabase(app.filename);
    db.createTenant({ id: 'other', token: 'other-setup-'.repeat(4) });
    db.close();
    await request('other-setup-'.repeat(4), '/api/auth/setup', 'POST', { username: winner, password: 'other-organization-password' });
    const other = await login(winner, 'other-organization-password', 'other');
    assert.notEqual(other.user.id, owner.user.id);
    assert.equal((await request(other.token, `/api/organization/members/${owner.user.id}`, 'PATCH', { role: 'viewer' })).status, 404);
    assert.equal((await request(other.token, `/api/organization/members/${owner.user.id}/password`, 'PUT', { password })).status, 404);
    assert.equal((await request(other.token, '/api/organization/members')).data.members?.length, 1);
    assert.equal((await request(other.token, '/api/bootstrap')).data.config?.assignee === 'admin-assignee', false);
    const audit = (await request(owner.token, '/api/organization/audit')).data.events || [];
    assert.ok(audit.some(event => event.action === 'member.password_reset'));
    assert.ok(audit.some(event => event.action === 'api.request' && event.actorName === 'admin'));
    assert.ok(!JSON.stringify(audit).includes(password));

    const secondOwner = await request(owner.token, '/api/organization/members', 'POST', { username: 'successor', password, role: 'owner' });
    assert.equal(secondOwner.status, 201);
    assert.equal((await request(owner.token, `/api/organization/members/${owner.user.id}`, 'PATCH', { role: 'viewer' })).status, 200);
    assert.equal((await request(owner.token, '/api/organization/members')).status, 403);
    for (let i = 0; i < 10; i++) assert.equal((await request(null, '/api/auth/login', 'POST', { username: 'rate-test' })).status, 401);
    assert.equal((await request(null, '/api/auth/login', 'POST', { username: 'rate-test' })).status, 429);
  } finally { await app.close(); await rm(rootDir, { recursive: true, force: true }); }
});

test('version 1 migration preserves tenant data; salted passwords, session expiry and concurrent privilege checks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bugflow-rbac-migration-'));
  const filename = path.join(root, 'workflow.sqlite');
  let raw = new DatabaseSync(filename);
  raw.exec(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
  raw.prepare('INSERT INTO tenants VALUES (?, ?, ?, ?)').run('test', 'Legacy organization', hashToken(setupToken), '2026-01-01');
  raw.prepare('INSERT INTO tenant_settings(tenant_id, config) VALUES (?, ?)').run('test', '{"assignee":"legacy-line"}');
  raw.prepare('INSERT INTO user_states VALUES (?, ?, ?)').run('test', 'person', '2026-01-01');
  raw.prepare('INSERT INTO workflow_items VALUES (?, ?, ?, ?, ?, ?)').run('test', 'person', 'bugs', 'legacy-bug', 0, '{"id":"legacy-bug","title":"preserved"}');
  raw.prepare('INSERT INTO workflow_items VALUES (?, ?, ?, ?, ?, ?)').run('test', 'person', 'runs', 'legacy-run', 0, '{"id":"legacy-run"}');
  raw.exec('PRAGMA user_version = 1'); raw.close();
  const db = openDatabase(filename);
  try {
    assert.equal(db.readSettings('test').config.assignee, 'legacy-line');
    assert.equal(db.createStore('test').readUserState('person').bugs[0].title, 'preserved');
    assert.equal(db.hasUsers('test'), false);
    assert.equal(db.authenticate(setupToken)!.id, 'test');
    const owner = await db.createUser('test', { username: 'owner', password }, { bootstrap: true });
    const admin = await db.createUser('test', { username: 'admin', password, role: 'admin' }, { actor: owner });
    const pending = db.createUser('test', { username: 'racing-user', password, role: 'viewer' }, { actor: admin });
    db.updateUser('test', admin.id, { role: 'viewer' }, owner);
    await assert.rejects(pending, { statusCode: 403 });
    assert.equal(db.listUsers('test').length, 2);
    const session = await db.login('test', 'owner', password);
    raw = new DatabaseSync(filename);
    const hashes = raw.prepare('SELECT password_hash FROM organization_users').all();
    assert.ok(hashes.every((row) => String(row.password_hash).startsWith('scrypt$') && !String(row.password_hash).includes(password)));
    assert.notEqual(hashes[0]!.password_hash, hashes[1]!.password_hash);
    raw.prepare('UPDATE user_sessions SET expires_at = ?').run(Date.now() - 1);
    assert.equal(db.authenticateSession(session.token), null);
    assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 7);
    assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflow_items'").get(), undefined);
    assert.equal(raw.prepare('SELECT count(*) AS count FROM issue_items').get()?.count, 1);
    raw.close();
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
