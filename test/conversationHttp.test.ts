import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import type { Execution } from '../public/taskTypes.js';

interface ApiData {
  token?: string; sessions?: Array<{ id: string }>; sessionId?: string; execution?: Execution | null;
  total?: number; [key: string]: unknown;
}

test('authenticated HTTP and real ACP subprocess support new conversation, two turns and switching back', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'conversation-http-'));
  const records = path.join(root, 'history'); await mkdir(records);
  await writeFile(path.join(records, 'session.jsonl'), [
    { type: 'session_meta', payload: { id: 'source-native', cwd: root } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '保持原接口兼容' }] } }
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const args = JSON.stringify([fileURLToPath(new URL('./fixtures/conversation-agent.mjs', import.meta.url))]);
  const setup = 'http-conversation-setup-'.repeat(3), password = 'conversation-test-password';
  const app = createApp({ rootDir: root, environment: { DEFAULT_TENANT_TOKEN: setup, CODEX_WORKSPACE_DIR: root, IDE_HISTORY_CODEX_DIR: records, IDE_HISTORY_CLAUDE_DIR: path.join(root, 'missing'), ACP_CODEX_EXECUTABLE: process.execPath, ACP_CLAUDE_EXECUTABLE: process.execPath, ACP_CODEX_ARGS: args, ACP_CLAUDE_ARGS: args } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  async function req(route: string, method = 'GET', body?: unknown, token?: string) {
    const result = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: result.status, data: await result.json() as ApiData };
  }
  await req('/api/auth/setup', 'POST', { username: 'owner', password }, setup);
  const token = (await req('/api/auth/login', 'POST', { tenantId: 'default', username: 'owner', password })).data.token;
  assert.ok(token);
  await req('/api/organization/members', 'POST', { username: 'viewer', role: 'viewer', password }, token);
  const viewer = (await req('/api/auth/login', 'POST', { tenantId: 'default', username: 'viewer', password })).data.token;
  assert.ok(viewer);
  const sessions = (await req('/api/agent-sessions', 'GET', undefined, token)).data.sessions;
  assert.ok(sessions?.[0]);
  const original = sessions[0].id;
  const route = `/api/sessions/${original}/continue-as-new`, input = { requestId: randomUUID(), targetAgent: 'claude' };
  assert.equal((await req(route, 'POST', input)).status, 401);
  assert.equal((await req(route, 'POST', input, viewer)).status, 403);
  const created = await req(route, 'POST', input, token); assert.equal(created.status, 202, JSON.stringify(created.data));
  const id = created.data.sessionId; assert.ok(id);
  const messageRoute = `/api/agent-sessions/${id}/continue`;
  assert.equal((await req(messageRoute, 'GET', undefined, token)).data.execution, null);
  async function send(message: string) {
    const sent = await req(messageRoute, 'POST', { requestId: randomUUID(), message }, token); assert.equal(sent.status, 202, JSON.stringify(sent.data));
    for (let i = 0; i < 100; i++) {
      const status = (await req(messageRoute, 'GET', undefined, token)).data.execution;
      assert.ok(status);
      if (status.status === 'completed') return status;
      assert.ok(!['unknown', 'failed'].includes(status.status), JSON.stringify(status));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('ACP turn did not finish');
  }
  const first = await send('按刚才的方案继续'); assert.ok(first?.output); assert.match(first.output, /保持原接口兼容/);
  const second = await send('继续检查'); assert.ok(second?.output); assert.match(second.output, /同一会话第 2 轮/); assert.equal(second.sessionId, first.sessionId);
  assert.equal((await req(`/api/agent-sessions/${id}`, 'GET', undefined, token)).data.total, 4);
  const switched = await req(`/api/sessions/${id}/continue-as-new`, 'POST', { requestId: randomUUID(), targetAgent: 'codex' }, token);
  assert.equal(switched.status, 202);
  assert.ok(switched.data.sessionId);
  const inherited = (await req(`/api/conversations/${switched.data.sessionId}/inherited`, 'GET', undefined, token)).data;
  assert.match(JSON.stringify(inherited), /保持原接口兼容/); assert.match(JSON.stringify(inherited), /工具结果已保留/);
  assert.equal((await req('/api/conversations', 'GET', undefined, token)).data.sessions?.length, 2);
});
