import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { openDatabase } from '../src/database.mjs';
import { assertSeparateWorkspaces, tenantEnvironment } from '../src/tenancy.mjs';

let tokenA = 'a'.repeat(43), tokenB = 'b'.repeat(43);
const environment = { DEFAULT_TENANT_TOKEN: 'd'.repeat(43) };
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP authentication, tenant configuration/data isolation, concurrent sync and restart recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bugflow-http-'));
  let app;
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  let enteredSlow;
  const entered = new Promise((resolve) => { enteredSlow = resolve; });
  const seenSecrets = [];
  const pm = http.createServer(async (req, res) => {
    const key = req.headers['x-access-key'];
    seenSecrets.push([key, req.headers['x-access-secret']]);
    req.resume();
    if (key === 'ak-a') { enteredSlow(); await slow; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 200, data: { page: { total: 1, records: [[
      { fieldCode: 'aid', value: 'same-bug' },
      { fieldCode: 'code', value: 'BUG-1' },
      { fieldCode: 'title', value: key, title: key },
      { fieldCode: 'status', value: 'open', title: '待处理' }
    ]] } } }));
  });
  try {
    const pmUrl = await listen(pm);
    app = createApp({ rootDir: root, environment });
    await app.close();
    const db = openDatabase(path.join(root, '.workflow-data/workflow.sqlite'));
    db.createTenant({ id: 'a', name: 'Team A', token: tokenA });
    db.createTenant({ id: 'b', name: 'Team B', token: tokenB });
    await db.createStore('a').writeUserState('default', { bugs: [], runs: [{ id: 'private-run', status: 'running', steps: [{ id: 'fix', status: 'running' }] }], executionRecords: [] });
    db.close();
    await mkdir(path.join(root, '.workflow-data/tenants'), { recursive: true });
    for (const id of ['a', 'b']) {
      await writeFile(path.join(root, `.workflow-data/tenants/${id}.env`), `PM_ACCESS_KEY=ak-${id}\nPM_ACCESS_SECRET=sk-${id}\nPM_BASE_URL=${pmUrl}\nPM_LINE_ID=line-${id}\nENABLE_AI_ASSIGNMENT=false\n`);
    }
    app = createApp({ rootDir: root, environment });
    let base = await listen(app.server);
    const request = async (token, endpoint, options = {}) => {
      const response = await fetch(`${base}${endpoint}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
      return { status: response.status, body: await response.json() };
    };
    for (const token of [tokenA, tokenB]) {
      assert.equal((await request(token, '/api/auth/setup', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'test-owner-password' }) })).status, 201);
    }
    tokenA = (await request(null, '/api/auth/login', { method: 'POST', body: JSON.stringify({ tenantId: 'a', username: 'owner', password: 'test-owner-password' }) })).body.token;
    tokenB = (await request(null, '/api/auth/login', { method: 'POST', body: JSON.stringify({ tenantId: 'b', username: 'owner', password: 'test-owner-password' }) })).body.token;
    assert.equal((await request(null, '/api/bootstrap')).status, 401);
    assert.equal((await request('invalid', '/api/config', { method: 'PUT', body: '{}' })).status, 401);
    assert.equal((await request(tokenA, '/api/bootstrap', { headers: { 'X-Tenant-Id': 'b' } })).status, 403);
    const a = await request(tokenA, '/api/bootstrap');
    assert.equal(a.body.tenant.id, 'a');
    assert.equal(a.body.runs[0].status, 'interrupted');
    assert.equal(a.body.config.lineId, 'line-a');
    assert.deepEqual(a.body.assignmentPeople, []);
    assert.ok(!JSON.stringify(a.body).includes('sk-a'));
    assert.equal((await request(tokenB, '/api/workflows/private-run/start', { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await request(tokenA, '/api/config', { method: 'PUT', body: JSON.stringify({ tenantId: 'b', filterId: 'filter-a' }) })).status, 200);
    assert.equal((await request(tokenB, '/api/bootstrap')).body.config.filterId, '');
    const peopleA = [{ name: 'Team A member', employeeId: 'a-person', responsibility: 'A only' }];
    assert.equal((await request(tokenA, '/api/assignment/people', { method: 'PUT', body: JSON.stringify({ people: peopleA }) })).status, 200);
    assert.deepEqual((await request(tokenB, '/api/assignment/people')).body.people, []);
    assert.equal((await request(tokenA, '/api/config', { method: 'PUT', body: '{invalid' })).status, 400);
    assert.equal((await request(tokenA, '/api/config', { method: 'PUT', body: JSON.stringify({ codexWorkspaceDir: '/tmp/other-tenant-repository' }) })).status, 400);
    const syncA = request(tokenA, '/api/sync', { method: 'POST', body: '{}' });
    await entered;
    assert.equal((await request(tokenA, '/api/config', { method: 'PUT', body: JSON.stringify({ assignee: 'someone-else' }) })).status, 409);
    const syncB = await request(tokenB, '/api/sync', { method: 'POST', body: '{}' });
    assert.equal(syncB.status, 200);
    assert.equal(syncB.body.bugs[0].title, 'ak-b');
    releaseSlow();
    assert.equal((await syncA).body.bugs[0].title, 'ak-a');
    assert.deepEqual(seenSecrets.sort(), [['ak-a', 'sk-a'], ['ak-b', 'sk-b']]);
    await request(tokenA, '/api/scheduler', { method: 'POST', body: '{"enabled":true}' });
    assert.equal((await request(tokenB, '/api/bootstrap')).body.scheduler.enabled, false);
    await request(tokenA, '/api/config', { method: 'PUT', body: '{"assignee":"new-person"}' });
    assert.equal((await request(tokenA, '/api/bootstrap')).body.bugs.length, 0);
    assert.equal((await request(tokenB, '/api/bootstrap')).body.bugs[0].title, 'ak-b');
    await request(tokenA, '/api/config', { method: 'PUT', body: '{"assignee":""}' });
    await app.close();
    app = createApp({ rootDir: root, environment });
    base = await listen(app.server);
    assert.equal((await request(tokenA, '/api/bootstrap')).body.bugs[0].title, 'ak-a');
    assert.equal((await request(tokenB, '/api/bootstrap')).body.bugs[0].title, 'ak-b');
    assert.equal((await request(tokenA, '/api/bootstrap')).body.config.filterId, 'filter-a');
    assert.deepEqual((await request(tokenA, '/api/assignment/people')).body.people, peopleA);
    const rotated = openDatabase(path.join(root, '.workflow-data/workflow.sqlite'));
    rotated.rotateToken('a', 'r'.repeat(43));
    rotated.close();
    assert.equal((await request(tokenA, '/api/bootstrap')).status, 200);
    assert.equal((await request('r'.repeat(43), '/api/bootstrap')).status, 401);
    assert.equal((await request('r'.repeat(43), '/api/auth/setup')).status, 409);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
  } finally {
    releaseSlow();
    if (app) await app.close();
    await new Promise((resolve) => pm.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('tenant credentials never inherit default tenant or server secrets; workspace overlap is rejected', () => {
  const env = tenantEnvironment({ id: 'b' }, '/tmp', {
    PM_ACCESS_SECRET: 'default-secret', OPENAI_API_KEY: 'default-ai', DEFAULT_TENANT_TOKEN: 'admin-token', PATH: '/bin', DATABASE_PATH: '/secret'
  });
  assert.deepEqual(env, { PATH: '/bin' });
  assert.throws(() => assertSeparateWorkspaces([{ id: 'a', workspace: '/tmp/repo' }, { id: 'b', workspace: '/tmp/repo/nested' }]), /重叠/);
  assert.doesNotThrow(() => assertSeparateWorkspaces([{ id: 'a', workspace: '/tmp/repo-a' }, { id: 'b', workspace: '/tmp/repo-b' }]));
});
