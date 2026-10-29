import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createApp, rawDatabase } from '../scripts/testing/database.js';

interface Member { id: string; username: string; role: string; enabled: number; updatedAt: string }
interface Data { id: string; token: string; deploymentToken: string; user: Member; tenant: { id: string }; members: Member[]; invitations: { id: string }[]; workspaces: { id: string }[]; tasks: { id: string }[]; task: { id: string }; message: string }
const password = 'team-workspace-password-2026';

test('team spaces isolate personal data and enforce invitations, live membership, idempotency and conflicts', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'workflow-spaces-'));
  const app = createApp({ rootDir, environment: { LOCAL_EXECUTION_ENABLED: 'false', ACP_ENABLED: 'false', CODEX_EXECUTABLE: '/nonexistent/team-test-codex' } });
  try {
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const address = app.server.address(); assert.ok(address && typeof address === 'object');
    const request = async (token: string | null, endpoint: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${endpoint}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() as Data };
    };
    const register = async (username: string) => {
      const response = await request(null, '/api/auth/register', 'POST', { username, displayName: username, password });
      assert.equal(response.status, 201, response.data.message); return response.data;
    };
    const owner = await register('space-owner'), colleague = await register('space-member'), outsider = await register('space-outsider');
    assert.equal((await request(null, '/api/workspaces')).status, 401);
    assert.equal((await request(owner.token, '/api/workspaces', 'POST', { name: '', requestId: randomUUID() })).status, 400);
    const create = { name: '研发协作', requestId: randomUUID() };
    const attempts = await Promise.all([request(owner.token, '/api/workspaces', 'POST', create), request(owner.token, '/api/workspaces', 'POST', create)]);
    assert.equal(attempts[0].status, 201); assert.equal(attempts[1].data.id, attempts[0].data.id);
    const teamId = attempts[0].data.id;
    assert.equal((await request(owner.token, '/api/workspaces', 'POST', { ...create, name: '不同空间' })).status, 409);
    assert.equal((await request(outsider.token, '/api/workspaces/switch', 'POST', { tenantId: teamId })).status, 403);
    assert.equal((await request(outsider.token, '/api/workspaces')).data.workspaces.length, 1);
    const team = (await request(owner.token, '/api/workspaces/switch', 'POST', { tenantId: teamId })).data;
    assert.equal(team.tenant.id, teamId);
    const personalTask = await request(owner.token, '/api/task-center', 'POST', { action: 'create', title: '个人秘密', content: '个人资料' });
    assert.equal(personalTask.status, 200);
    assert.equal((await request(team.token, '/api/task-center')).data.tasks.length, 0);
    const teamTask = await request(team.token, '/api/task-center', 'POST', { action: 'create', title: '共享目标', content: '团队资料' });
    assert.equal(teamTask.status, 200);
    assert.equal((await request(owner.token, '/api/task-center')).data.tasks.length, 1);
    assert.equal((await request(team.token, '/api/organization/members', 'POST', { username: 'bad-proxy', password, role: 'owner' })).status, 400);
    const invitations = await Promise.all([request(team.token, '/api/workspaces/invitations', 'POST', { username: 'space-member', role: 'viewer' }), request(team.token, '/api/workspaces/invitations', 'POST', { username: 'space-member', role: 'viewer' })]);
    assert.equal(invitations[0].status, 201); assert.equal(invitations[0].data.id, invitations[1].data.id);
    const inviteId = invitations[0].data.id;
    assert.equal((await request(team.token, '/api/workspaces/invitations', 'POST', { username: 'space-member', role: 'admin' })).status, 409);
    assert.equal((await request(outsider.token, `/api/workspaces/invitations/${inviteId}/accept`, 'POST')).status, 404);
    assert.equal((await request(colleague.token, '/api/workspaces')).data.invitations.length, 1);
    const accepted = await Promise.all([request(colleague.token, `/api/workspaces/invitations/${inviteId}/accept`, 'POST'), request(colleague.token, `/api/workspaces/invitations/${inviteId}/accept`, 'POST')]);
    assert.ok(accepted.every(result => result.status === 200 && result.data.id === teamId));
    const viewer = (await request(colleague.token, '/api/workspaces/switch', 'POST', { tenantId: teamId })).data;
    const members = (await request(viewer.token, '/api/workspaces/members')).data.members;
    assert.equal(members.length, 2);
    assert.equal((await request(viewer.token, '/api/task-center')).data.tasks.length, 1);
    assert.equal((await request(viewer.token, '/api/task-center', 'POST', { action: 'create', title: '不允许', content: '' })).status, 403);
    assert.equal((await request(viewer.token, '/api/workspaces/invitations', 'POST', { username: 'space-outsider' })).status, 403);
    assert.equal((await request(viewer.token, '/api/auth/password', 'PUT', { password })).status, 400);
    assert.equal((await request(team.token, `/api/organization/members/${colleague.user.id}`, 'PATCH', { role: 'owner' })).status, 404);
    const member = members.find(item => item.username === 'space-member')!;
    const updates = await Promise.all([
      request(team.token, `/api/organization/members/${member.id}`, 'PATCH', { role: 'admin', expectedUpdatedAt: member.updatedAt }),
      request(team.token, `/api/organization/members/${member.id}`, 'PATCH', { role: 'operator', expectedUpdatedAt: member.updatedAt })
    ]);
    assert.deepEqual(updates.map(result => result.status).sort(), [200, 409]);
    const latest = (await request(team.token, '/api/workspaces/members')).data.members.find(item => item.id === member.id)!;
    await request(team.token, `/api/organization/members/${member.id}`, 'PATCH', { role: 'admin', expectedUpdatedAt: latest.updatedAt });
    assert.equal((await request(viewer.token, '/api/workspaces/invitations', 'POST', { username: 'space-outsider', role: 'admin' })).status, 403);
    const ownerMember = members.find(item => item.role === 'owner')!;
    assert.equal((await request(viewer.token, `/api/organization/members/${ownerMember.id}`, 'PATCH', { role: 'viewer', expectedUpdatedAt: ownerMember.updatedAt })).status, 403);
    assert.equal((await request(team.token, `/api/organization/members/${ownerMember.id}`, 'PATCH', { role: 'viewer', expectedUpdatedAt: ownerMember.updatedAt })).status, 409);
    for (const role of [['admin'], { role: 'admin' }, false, 'owner']) assert.equal((await request(viewer.token, '/api/workspaces/invitations', 'POST', { username: 'space-outsider', role })).status, 400);
    const pending = (await request(team.token, '/api/workspaces/invitations', 'POST', { username: 'space-outsider' })).data;
    assert.equal((await request(owner.token, `/api/workspaces/invitations/${pending.id}`, 'DELETE')).status, 400);
    assert.equal((await request(team.token, `/api/workspaces/invitations/${pending.id}`, 'DELETE')).status, 200);
    assert.equal((await request(outsider.token, `/api/workspaces/invitations/${pending.id}/accept`, 'POST')).status, 409);
    const expiring = (await request(team.token, '/api/workspaces/invitations', 'POST', { username: 'space-outsider' })).data;
    const raw = rawDatabase(app.databaseKey);
    try { raw.prepare('UPDATE workspace_invitations SET expires_at = 0 WHERE id = ?').run(expiring.id); } finally { raw.close(); }
    assert.equal((await request(outsider.token, `/api/workspaces/invitations/${expiring.id}/accept`, 'POST')).status, 409);
    const deployment = (await request(team.token, '/api/auth/device-deployment', 'POST', {})).data;
    const connector = (await request(null, '/api/auth/device-deployment/exchange', 'POST', { deploymentToken: deployment.deploymentToken })).data;
    for (const [endpoint, method] of [['/api/workspaces', 'GET'], ['/api/workspaces/switch', 'POST'], ['/api/workspaces/members', 'GET']]) assert.equal((await request(connector.token, endpoint, method, method === 'POST' ? { tenantId: teamId } : undefined)).status, 403);
    const fresh = (await request(team.token, '/api/workspaces/members')).data.members.find(item => item.id === member.id)!;
    assert.equal((await request(team.token, `/api/organization/members/${member.id}`, 'PATCH', { enabled: false, expectedUpdatedAt: fresh.updatedAt })).status, 200);
    assert.equal((await request(viewer.token, '/api/bootstrap')).status, 401);
    assert.equal((await request(colleague.token, '/api/workspaces/switch', 'POST', { tenantId: teamId })).status, 403);
    assert.equal((await request(colleague.token, `/api/workspaces/invitations/${inviteId}/accept`, 'POST')).status, 409);
    const reInvite = (await request(team.token, '/api/workspaces/invitations', 'POST', { username: 'space-member', role: 'operator' })).data;
    const disabled = (await request(team.token, '/api/workspaces/members')).data.members.find(item => item.id === member.id)!;
    assert.equal((await request(team.token, `/api/organization/members/${member.id}`, 'PATCH', { enabled: true, role: 'owner', expectedUpdatedAt: disabled.updatedAt })).status, 200);
    assert.equal((await request(colleague.token, `/api/workspaces/invitations/${reInvite.id}/accept`, 'POST')).status, 200);
    assert.equal((await request(team.token, '/api/workspaces/members')).data.members.find(item => item.id === member.id)!.role, 'owner');
    const recovered = (await request(colleague.token, '/api/workspaces/switch', 'POST', { tenantId: teamId })).data;
    assert.equal((await request(recovered.token, '/api/task-center')).status, 200);
    const relogin = await request(null, '/api/auth/login', 'POST', { username: 'space-member', password });
    assert.equal(relogin.status, 200); assert.equal(relogin.data.tenant.id, colleague.tenant.id);
    assert.equal((await request(colleague.token, '/api/auth/password', 'PUT', { currentPassword: password, password: `${password}-new` })).status, 200);
    assert.equal((await request(recovered.token, '/api/bootstrap')).status, 401);
    assert.equal((await request(team.token, '/api/workspaces/switch', 'POST', { tenantId: owner.tenant.id })).data.tenant.id, owner.tenant.id);
  } finally { await app.close(); await rm(rootDir, { recursive: true, force: true }); }
});

test('version 9 upgrades existing personal identities without moving data and survives reopen', async () => {
  const { openDatabase } = await import('../scripts/testing/database.js');
  const key = randomUUID();
  const db = openDatabase(key);
  db.createTenant({ id: 'default', token: 'migration-team-token'.repeat(3) });
  const session = await db.registerPersonal({ username: 'migration-owner', password });
  const before = db.authenticateSession(session.token)!;
  db.close();
  const old = rawDatabase(key);
  old.prepare('DROP TABLE workspace_invitations, workspace_memberships, team_workspaces').run();
  old.prepare('DELETE FROM schema_migrations WHERE version = 9').run(); old.close();
  const upgraded = openDatabase(key);
  try {
    const principal = upgraded.authenticateSession(session.token)!;
    assert.equal(principal.tenant.id, before.tenant.id);
    assert.equal(principal.user.id, before.user.id);
    assert.equal(upgraded.workspaces(principal).workspaces.length, 1);
    const created = upgraded.createWorkspace(principal, { name: '升级后的团队', requestId: randomUUID() });
    assert.equal(upgraded.workspaces(principal).workspaces.length, 2);
    assert.equal(upgraded.workspaces(principal).workspaces[1].id, created.id);
    upgraded.logout(session.token);
    assert.throws(() => upgraded.switchWorkspace({ ...principal, token: session.token }, { tenantId: created.id }), /会话已失效/);
  } finally { upgraded.close(); }
  const reopened = openDatabase(key);
  try { const newSession = await reopened.loginPersonal('migration-owner', password); assert.equal(reopened.workspaces(reopened.authenticateSession(newSession.token)!).workspaces.length, 2); } finally { reopened.close(); }
});
