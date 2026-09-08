import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { openDatabase } from '../src/database.mjs';
import type { Environment } from '../src/issueSources/types.ts';

test('Jira runtime sync, attachment/assignment dispatch, auth, failure atomicity and source switching', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'jira-runtime-'));
  const originalFetch = globalThis.fetch;
  const setupToken = 'synthetic-setup-token-'.repeat(3);
  const environment: Environment = {
    DEFAULT_TENANT_TOKEN: setupToken, ISSUE_PROVIDER: 'jira',
    JIRA_BASE_URL: 'https://jira.example.com', JIRA_JQL: 'project = DEMO',
    JIRA_EMAIL: 'test@example.com', JIRA_API_TOKEN: 'fictional-jira-token',
    ENABLE_AI_ASSIGNMENT: 'false', ENABLE_AI_ROUTING: 'false'
  };
  let app: ReturnType<typeof createApp> | undefined;
  let base = '', fail = false;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://jira.example.com/')) return originalFetch(input, init);
    calls.push(url);
    assert.equal(new Headers(init?.headers).get('authorization'), `Basic ${Buffer.from('test@example.com:fictional-jira-token').toString('base64')}`);
    assert.equal(new Headers(init?.headers).get('x-access-key'), null);
    if (url.includes('/assignee')) {
      assert.equal(init?.method, 'PUT');
      assert.deepEqual(JSON.parse(String(init?.body)), { accountId: 'account-b' });
      return new Response(null, { status: 204 });
    }
    if (url.includes('?fields=attachment')) return Response.json({ fields: { attachment: [{ id: 'a', filename: 'demo.txt', content: 'https://jira.example.com/rest/api/3/attachment/content/a' }] } });
    if (fail) return Response.json({ echo: 'fictional-jira-token' }, { status: 401 });
    return Response.json({ isLast: true, issues: [{ id: '100', key: 'DEMO-1', fields: { summary: 'Synthetic issue', status: { name: 'Open', statusCategory: { key: 'new' } }, updated: '2026-01-01T00:00:00Z' } }] });
  };
  async function start() {
    app = createApp({ rootDir, environment });
    await new Promise<void>(resolve => app!.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    base = `http://127.0.0.1:${address.port}`;
  }
  async function request(token: string | null, endpoint: string, method = 'GET', body?: unknown) {
    const response = await originalFetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  try {
    await start();
    assert.equal((await request(setupToken, '/api/auth/setup', 'POST', { username: 'owner', password: 'synthetic-owner-password' })).status, 201);
    const owner = (await request(null, '/api/auth/login', 'POST', { tenantId: 'default', username: 'owner', password: 'synthetic-owner-password' })).body.token as string;
    await request(owner, '/api/organization/members', 'POST', { username: 'viewer', password: 'synthetic-viewer-password', role: 'viewer' });
    const viewer = (await request(null, '/api/auth/login', 'POST', { tenantId: 'default', username: 'viewer', password: 'synthetic-viewer-password' })).body.token as string;
    assert.equal((await request(null, '/api/sync', 'POST')).status, 401);
    assert.equal((await request(viewer, '/api/sync', 'POST')).status, 403);
    assert.equal((await request(viewer, '/api/issues/diagnostics')).status, 403);
    const synced = await request(owner, '/api/sync', 'POST');
    assert.equal(synced.status, 200);
    assert.equal(synced.body.config.mode, 'jira');
    assert.equal(synced.body.config.issueSourceConfigured, true);
    assert.equal(synced.body.bugs[0].id, 'jira:100');
    assert.doesNotMatch(JSON.stringify(synced.body), /fictional-jira-token/);
    assert.match(synced.body.storageUserKey, /^jira-/);
    const checkpoint = synced.body.scheduler.lastSyncTime;
    assert.equal((await request(viewer, '/api/bugs/jira%3A100/attachments')).body.attachments[0].name, 'demo.txt');
    const assignment = await request(owner, '/api/bugs/jira%3A100/assignment/apply', 'POST', { assigneeId: 'account-b' });
    assert.equal(assignment.status, 200);
    assert.ok(calls.some(url => url.endsWith('/issue/100/assignee')));
    assert.equal((await request(owner, '/api/issues/diagnostics')).body.checks[0].ok, true);
    fail = true;
    const failed = await request(owner, '/api/sync', 'POST');
    assert.equal(failed.status, 400);
    assert.equal(failed.body.bugs[0].id, 'jira:100');
    assert.equal(failed.body.scheduler.lastSyncTime, checkpoint);
    assert.doesNotMatch(JSON.stringify(failed.body), /fictional-jira-token/);
    // Persisted legacy keys remain recoverable and are never mixed with Jira IDs.
    await app!.close(); app = undefined;
    const db = openDatabase(path.join(rootDir, '.workflow-data/workflow.sqlite'));
    await db.createStore('default').writeUserState('default', { bugs: [{ id: '100', aid: '100', title: 'Legacy PM issue' }], runs: [], executionRecords: [] });
    db.close();
    environment.ISSUE_PROVIDER = 'pm';
    await start();
    assert.equal((await request(owner, '/api/bootstrap')).body.bugs[0].title, 'Legacy PM issue');
    await app!.close(); app = undefined;
    environment.ISSUE_PROVIDER = 'jira';
    await start();
    assert.equal((await request(owner, '/api/bootstrap')).body.bugs[0].id, 'jira:100');
  } finally {
    if (app) await app.close();
    globalThis.fetch = originalFetch;
    await rm(rootDir, { recursive: true, force: true });
  }
});
