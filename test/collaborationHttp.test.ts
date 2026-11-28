import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CollaborationDetail } from '../shared/collaborationTypes.js';
import type { TaskCenterData } from '../shared/taskTypes.js';
import { createApp } from '../scripts/testing/database.js';

test('only team members can read collaborations and only execution roles can publish or dispatch', async t => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'collaboration-http-'));
  const app = createApp({ rootDir, environment: { LOCAL_EXECUTION_ENABLED: 'false', ACP_ENABLED: 'false', CODEX_EXECUTABLE: '/nonexistent/test-codex' } });
  t.after(async () => { await app.close(); await rm(rootDir, { force: true, recursive: true }); });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const request = (token: string, endpoint: string, method = 'GET', body?: unknown) => fetch(
    `http://127.0.0.1:${address.port}${endpoint}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  const post = async <T>(token: string, endpoint: string, body: unknown, status: number): Promise<T> => {
    const response = await request(token, endpoint, 'POST', body);
    assert.equal(response.status, status);
    return await response.json() as T;
  };
  const register = (username: string) => post<{ token: string }>('', '/api/auth/register', { username, password: 'collaboration-test-password' }, 201);
  const createTeam = (token: string, name: string) => post<{ id: string }>(token, '/api/workspaces', { name, requestId: randomUUID() }, 201);
  const enter = (token: string, tenantId: string) => post<{ token: string }>(token, '/api/workspaces/switch', { tenantId }, 200);
  const owner = await register('collaboration-owner');
  const member = await register('collaboration-reader');
  const team = await createTeam(owner.token, '研发团队');
  const other = await createTeam(member.token, '其他团队');
  const { token } = await enter(owner.token, team.id);
  const invitation = await post<{ id: string }>(token, '/api/workspaces/invitations', { username: 'collaboration-reader', role: 'viewer' }, 201);
  await post(member.token, `/api/workspaces/invitations/${invitation.id}/accept`, {}, 200);
  const viewer = await enter(member.token, team.id);
  const outsider = await enter(member.token, other.id);
  const base = '/api/workspaces/collaborations';
  assert.equal((await request('', base)).status, 401);
  assert.equal((await request(owner.token, base)).status, 400);
  const { deploymentToken } = await post<{ deploymentToken: string }>(token, '/api/auth/device-deployment', {}, 201);
  const connector = await post<{ token: string }>('', '/api/auth/device-deployment/exchange', { deploymentToken }, 200);
  const participants = ['api', 'web'].map(name => ({
    name, responsibility: `实现 ${name} 模块`, projectId: 'repo', deviceId: `device-${name}`
  }));
  for (const p of participants) {
    await post(connector.token, '/api/task-center', {
      action: 'heartbeat', deviceId: p.deviceId, name: p.name, agents: ['codex'], capabilities: { collaborationSessions: true }, sessions: [],
      codexProjects: [{ id: 'repo', cwd: `/repo/${p.name}`, name: p.name, agent: 'codex', protocol: 'acp' }]
    }, 200);
  }
  const input = { title: '联调登录', goal: '交付登录功能', participants, requestId: randomUUID() };
  assert.equal((await request(viewer.token, base, 'POST', input)).status, 403);
  const { id } = await post<{ id: string }>(token, base, input, 201);
  const endpoint = `${base}/${id}`;
  const detail = async () => (await (await request(viewer.token, endpoint)).json() as { collaboration: CollaborationDetail }).collaboration;
  const initial = await detail();
  const doc = { title: '登录协议', body: '响应字段为 displayName', fromParticipantId: initial.participants[0].id,
    toParticipantId: initial.participants[1].id, revision: initial.revision, requestId: randomUUID() };
  assert.equal((await request(outsider.token, endpoint)).status, 404);
  assert.equal((await request(outsider.token, `${endpoint}/documents`, 'POST', doc)).status, 404);
  assert.equal((await request(viewer.token, `${endpoint}/documents`, 'POST', doc)).status, 403);
  const document = await post<{ id: string }>(token, `${endpoint}/documents`, doc, 201);
  const updated = await detail();
  assert.equal(updated.documents[0].body, doc.body);
  const run = { requestId: randomUUID(), revision: updated.revision, participantId: doc.toParticipantId, documentIds: [document.id] };
  assert.equal((await request(viewer.token, `${endpoint}/runs`, 'POST', run)).status, 403);
  assert.equal((await request(connector.token, endpoint)).status, 403);
  assert.equal((await request(connector.token, `${endpoint}/runs`, 'POST', run)).status, 403);
  assert.equal((await request(token, `${endpoint}/other`, 'POST', {})).status, 404);
  assert.equal((await request(token, `${endpoint}/documents`, 'GET')).status, 404);
  const execution = await post<{ executionId: string }>(token, `${endpoint}/runs`, run, 202);
  const snapshot = async (suffix = '') => (await (await request(connector.token, '/api/task-center' + suffix)).json()) as TaskCenterData;
  const sync = await snapshot();
  assert.ok(!('collaborations' in sync));
  assert.ok(!JSON.stringify(sync).includes(doc.body));
  const source = await snapshot('/device-state?deviceId=device-api');
  assert.ok(!JSON.stringify(source).includes(doc.body));
  const destination = await snapshot('/device-state?deviceId=device-web');
  assert.equal(destination.executions[0].id, execution.executionId);
  assert.ok(destination.executions[0].prompt.includes(doc.body));
  const heartbeat = { action: 'heartbeat', deviceId: 'device-web', name: 'web', agents: ['codex'], sessions: [] };
  await post(connector.token, '/api/task-center', heartbeat, 200);
  const claim = { action: 'claim', executionId: execution.executionId };
  assert.equal((await request(connector.token, '/api/task-center/execution-action', 'POST', claim)).status, 422);
  await post(connector.token, '/api/task-center', { ...heartbeat, capabilities: { collaborationSessions: true } }, 200);
  await post(connector.token, '/api/task-center/execution-action', claim, 200);
  const browserSnapshot = await (await request(token, '/api/task-center')).json() as TaskCenterData;
  assert.ok(!('collaborations' in browserSnapshot));
  assert.ok(browserSnapshot.tasks.some(item => item.id === initial.parentTaskId));
});
