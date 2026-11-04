import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../scripts/testing/database.js';
import type { GroupChatRoom } from '../shared/groupChatTypes.js';
import type { Execution } from '../shared/taskTypes.js';

interface Data { id: string; token: string; deploymentToken: string; room: GroupChatRoom; rooms: { id: string }[]; executions: Execution[]; user: { id: string }; tenant: { id: string }; message: string }
const password = 'group-chat-http-password-2026';
test('group chat HTTP enforces team membership, roles, tenant boundaries and idempotent sends', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'workflow-group-chat-'));
  const app = createApp({ rootDir, environment: { LOCAL_EXECUTION_ENABLED: 'false', ACP_ENABLED: 'false', CODEX_EXECUTABLE: '/nonexistent/chat-test-codex' } });
  try {
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const address = app.server.address(); assert.ok(address && typeof address === 'object');
    const request = async (token: string | null, endpoint: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${endpoint}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() as Data };
    };
    const register = async (username: string) => (await request(null, '/api/auth/register', 'POST', { username, password })).data;
    const owner = await register('chat-owner'), member = await register('chat-member'), outsider = await register('chat-outsider');
    const base = '/api/workspaces/chats';
    assert.equal((await request(null, base)).status, 401);
    assert.equal((await request(owner.token, base)).status, 400);
    const team = (await request(owner.token, '/api/workspaces', 'POST', { name: '群聊团队', requestId: randomUUID() })).data;
    const token = (await request(owner.token, '/api/workspaces/switch', 'POST', { tenantId: team.id })).data.token;
    const invitation = (await request(token, '/api/workspaces/invitations', 'POST', { username: 'chat-member', role: 'viewer' })).data;
    await request(member.token, `/api/workspaces/invitations/${invitation.id}/accept`, 'POST');
    const viewerToken = (await request(member.token, '/api/workspaces/switch', 'POST', { tenantId: team.id })).data.token;
    assert.equal((await request(token, '/api/task-center', 'POST', { action: 'heartbeat', deviceId: 'chat-device', name: '测试设备', agents: ['codex', 'claude'], codexProjects: [{ id: 'codex', name: 'Codex', agent: 'codex', cwd: '/repo' }, { id: 'claude', name: 'Claude', agent: 'claude', cwd: '/repo' }], sessions: [] })).status, 200);
    const input = { name: '研发讨论', requestId: randomUUID(), participants: ['codex', 'claude'].map(agent => ({ name: agent, deviceId: 'chat-device', projectId: agent })) };
    assert.equal((await request(viewerToken, base, 'POST', input)).status, 403);
    for (const participants of [[], [input.participants[0]], [null, {}]]) assert.equal((await request(token, base, 'POST', { ...input, participants })).status, 400);
    const created = await request(token, base, 'POST', input); assert.equal(created.status, 201, created.data.message);
    const id = created.data.id;
    assert.equal((await request(token, base, 'POST', input)).data.id, id);
    assert.equal((await request(token, base, 'POST', { ...input, name: '其他讨论' })).status, 409);
    assert.equal((await request(viewerToken, `${base}/${id}`)).data.room.name, '研发讨论');
    assert.equal((await request(outsider.token, `${base}/${id}`)).status, 400);
    const otherTeam = (await request(outsider.token, '/api/workspaces', 'POST', { name: '其他团队', requestId: randomUUID() })).data;
    const otherToken = (await request(outsider.token, '/api/workspaces/switch', 'POST', { tenantId: otherTeam.id })).data.token;
    assert.equal((await request(otherToken, `${base}/${id}`)).status, 404);
    assert.equal((await request(otherToken, base)).data.rooms.length, 0);
    const send = { requestId: randomUUID(), revision: 1, message: '讨论权限设计' };
    assert.equal((await request(viewerToken, `${base}/${id}/messages`, 'POST', send)).status, 403);
    assert.equal((await request(token, `${base}/${id}/messages`, 'POST', { ...send, revision: 0 })).status, 409);
    assert.equal((await request(token, `${base}/${id}/messages`, 'POST', send)).status, 200);
    assert.equal((await request(token, `${base}/${id}/messages`, 'POST', send)).status, 200);
    assert.equal((await request(token, `${base}/${id}/messages`, 'POST', { ...send, requestId: randomUUID() })).status, 409);
    assert.equal((await request(token, `${base}/${id}`)).data.room.messages.length, 3);
    assert.equal((await request(otherToken, `${base}/${id}/messages`, 'POST', send)).status, 404);
    assert.equal((await request(viewerToken, `${base}/${id}/stop`, 'POST', { revision: 2 })).status, 403);
    const current = (await request(token, `${base}/${id}`)).data.room;
    assert.equal((await request(token, `${base}/${id}/stop`, 'POST', { revision: current.revision })).status, 200);
    assert.equal((await request(token, `${base}/${id}/stop`, 'POST', { revision: current.revision })).status, 200);
    const deployment = (await request(token, '/api/auth/device-deployment', 'POST', {})).data;
    const connector = (await request(null, '/api/auth/device-deployment/exchange', 'POST', { deploymentToken: deployment.deploymentToken })).data;
    for (const [endpoint, method, body] of [[base, 'GET', undefined], [base, 'POST', input], [`${base}/${id}/messages`, 'POST', send]] as const) assert.equal((await request(connector.token, endpoint, method, body)).status, 403);
    assert.equal((await request(token, `${base}/${id}/unknown`, 'POST', {})).status, 404);
  } finally { await app.close(); await rm(rootDir, { recursive: true, force: true }); }
});
