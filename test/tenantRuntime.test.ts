import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../scripts/testing/database.js';

interface ApiData { token?: string; error?: string; [key: string]: unknown }

test('tenant runtime allows reads during a mutation and still rejects competing writes', async t => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'tenant-runtime-'));
  const setupToken = 'tenant-runtime-setup-'.repeat(3);
  const originalFetch = globalThis.fetch;
  let releaseSync: (() => void) | undefined;
  let syncStarted: (() => void) | undefined;
  const syncGate = new Promise<void>(resolve => { releaseSync = resolve; });
  const started = new Promise<void>(resolve => { syncStarted = resolve; });
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith('https://jira.example.com/')) return originalFetch(input, init);
    syncStarted?.();
    await syncGate;
    return Response.json({ isLast: true, issues: [] });
  };
  const app = createApp({ rootDir, environment: {
    DEFAULT_TENANT_TOKEN: setupToken,
    ISSUE_PROVIDER: 'jira',
    JIRA_BASE_URL: 'https://jira.example.com',
    JIRA_JQL: 'project = TEST',
    JIRA_EMAIL: 'test@example.com',
    JIRA_API_TOKEN: 'test-token',
    ENABLE_AI_ASSIGNMENT: 'false'
  } });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    releaseSync?.();
    globalThis.fetch = originalFetch;
    await app.close();
    await rm(rootDir, { recursive: true, force: true });
  });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  async function request(route: string, method = 'GET', body?: unknown, token?: string) {
    const response = await originalFetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, data: await response.json() as ApiData };
  }

  assert.equal((await request('/api/auth/setup', 'POST', { username: 'owner', password: 'tenant-runtime-password' }, setupToken)).status, 201);
  const login = await request('/api/auth/login', 'POST', { tenantId: 'default', username: 'owner', password: 'tenant-runtime-password' });
  assert.ok(login.data.token);

  const syncing = request('/api/sync', 'POST', undefined, login.data.token);
  await started;
  const read = await request('/api/task-center', 'GET', undefined, login.data.token);
  assert.equal(read.status, 200, JSON.stringify(read.data));
  const competingWrite = await request('/api/scheduler', 'POST', { enabled: false }, login.data.token);
  assert.equal(competingWrite.status, 409);
  assert.equal(competingWrite.data.error, 'tenant_busy');
  releaseSync?.();
  assert.equal((await syncing).status, 200);
});

test('search API enforces authentication, scope validation, tenant isolation and unchanged task content', async t => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'search-runtime-'));
  const originalFetch = globalThis.fetch;
  let release: (() => void) | undefined, started: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('http://embedding.test/')) return originalFetch(url, init);
    started?.(); await gate;
    const { input } = JSON.parse(String(init?.body)) as { input: string[] };
    return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) });
  };
  const app = createApp({ rootDir, environment: { LOCAL_EXECUTION_ENABLED: 'false', ACP_ENABLED: 'false', CODEX_EXECUTABLE: '/nonexistent/codex',
    IDE_HISTORY_CODEX_DIR: path.join(rootDir, 'absent'), IDE_HISTORY_CLAUDE_DIR: path.join(rootDir, 'absent'),
    VECTOR_SEARCH_ENABLED: 'true', VECTOR_SEARCH_DIMENSIONS: '2', VECTOR_SEARCH_BASE_URL: 'http://embedding.test/v1' } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { release?.(); await app.close(); globalThis.fetch = originalFetch; await rm(rootDir, { recursive: true, force: true }); });
  const address = app.server.address(); assert.ok(address && typeof address === 'object');
  const request = async (route: string, token?: string, method = 'GET', body?: unknown) => {
    const response = await originalFetch(`http://127.0.0.1:${address.port}${route}`, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() as { token: string; tenant: { id: string }; taskId: string; ids: string[]; mode: string; revision: number } };
  };
  const account = async (username: string) => {
    const created = await request('/api/auth/register', undefined, 'POST', { username, password: 'search-test-password' });
    assert.equal(created.status, 201);
    const login = await request('/api/auth/login', undefined, 'POST', { username, password: 'search-test-password' });
    await mkdir(path.join(rootDir, '.workflow-data/tenants'), { recursive: true });
    await writeFile(path.join(rootDir, '.workflow-data/tenants', login.data.tenant.id + '.env'), 'VECTOR_SEARCH_ENABLED=true\nVECTOR_SEARCH_DIMENSIONS=2\nVECTOR_SEARCH_BASE_URL=http://embedding.test/v1\n');
    return login.data.token;
  };
  const a = await account('search-a'), b = await account('search-b');
  const task = await request('/api/task-center', a, 'POST', { action: 'create', title: '修复登录', content: '修复登录流程' });
  assert.equal(task.status, 200);
  const url = `/api/search?scope=tasks&q=${encodeURIComponent('身份认证')}`;
  assert.equal((await request(url)).status, 401);
  assert.equal((await request('/api/search?scope=unknown&q=x', a)).status, 400);
  assert.equal((await request('/api/search?scope=tasks&q=' + 'x'.repeat(201), a)).status, 400);
  assert.equal((await request(url, a, 'POST', {})).status, 404);
  const found = await request(url, a);
  assert.equal(found.status, 200); assert.equal(found.data.mode, 'hybrid'); assert.deepEqual(found.data.ids, [task.data.taskId]);
  assert.deepEqual((await request(url + '&tenantId=default', b)).data.ids, []);
  assert.deepEqual((await request('/api/search?scope=bugs&q=x', a)).data.ids, []);
  gate = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  const pending = request('/api/search?scope=tasks&q=new-query', a);
  await began;
  const update = await request('/api/task-center', a, 'POST', { action: 'update', taskId: task.data.taskId, revision: task.data.revision, status: 'ready', title: '报表', content: '导出报表' });
  assert.equal(update.status, 200);
  release!();
  assert.deepEqual((await pending).data.ids, []);
});
