import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';

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
