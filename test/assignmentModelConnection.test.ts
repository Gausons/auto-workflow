import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp, openDatabase } from '../scripts/testing/database.js';
import { readJson } from '../src/http/body.js';

const probePath = '/api/config/model-connection';
const setupToken = 'synthetic-model-setup-token-'.repeat(3);
const envKey = 'synthetic-deployment-key';
const savedKey = 'synthetic-saved-key';
const password = 'synthetic-model-password';
const model = 'vendor/custom-model';

test('assignment model settings connect to local addresses and persist selections and credentials per tenant', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'assignment-model-'));
  const calls: { path: string | undefined; authorization: string | undefined; body: Record<string, unknown> }[] = [];
  async function respondToModel(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req);
    calls.push({ path: req.url, authorization: req.headers.authorization, body });
    if (body.model === 'blocked-model') {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ echoed: req.headers.authorization }));
      return;
    }
    if (body.model === 'redirect-model') {
      res.writeHead(307, { Location: '/redirected' }).end();
      return;
    }
    if (body.model === 'slow-model') {
      upstream.emit('slow-probe', res);
      return;
    }
    const output = Array.isArray(body.input)
      ? { assigneeId: '42', assigneeName: '小李', confidence: 'high', reason: '符合职责', matchedResponsibility: '前端' }
      : { ok: true };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ output_text: JSON.stringify(output) }));
  }
  const upstream = createServer(respondToModel);
  const ipv6Upstream = createServer(respondToModel);
  let app: ReturnType<typeof createApp> | undefined;
  let appUrl: string;
  try {
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const address = upstream.address();
    assert.ok(address && typeof address === 'object');
    ipv6Upstream.listen(0, '::1'); await once(ipv6Upstream, 'listening');
    const ipv6Address = ipv6Upstream.address();
    assert.ok(ipv6Address && typeof ipv6Address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const localhostUrl = `http://localhost:${address.port}/v1`;
    const ipv6Url = `http://[::1]:${ipv6Address.port}/v1`;
    const environment = { DEFAULT_TENANT_TOKEN: setupToken, OPENAI_BASE_URL: localhostUrl, OPENAI_API_KEY: envKey, LOCAL_EXECUTION_ENABLED: 'false' };
    async function start() {
      const launched = createApp({ rootDir, environment });
      app = launched;
      launched.server.listen(0, '127.0.0.1'); await once(launched.server, 'listening');
      const appAddress = launched.server.address();
      assert.ok(appAddress && typeof appAddress === 'object');
      appUrl = `http://127.0.0.1:${appAddress.port}`;
      return launched;
    }
    const request = async (token: string | undefined, endpoint: string, method = 'GET', body?: unknown, tenantId?: string) => {
      const res = await fetch(appUrl + endpoint, { method, headers: {
        'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(tenantId ? { 'X-Tenant-Id': tenantId } : {})
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, data: await res.json() as { token?: string; storageUserKey?: string; config?: Record<string, unknown>; recommendation?: { status?: string } } };
    };
    app = await start();
    assert.equal((await request(undefined, probePath, 'POST', {})).status, 401);
    assert.equal((await request(setupToken, '/api/auth/setup', 'POST', { username: 'owner', password })).status, 201);
    const owner = (await request(undefined, '/api/auth/login', 'POST', { tenantId: 'default', username: 'owner', password })).data.token;
    assert.ok(owner);
    const other = (await request(undefined, '/api/auth/register', 'POST', { username: 'other', password })).data.token;
    assert.ok(other);
    const draft = { aiAssignmentModel: model, openaiBaseUrl: `${baseUrl}/`, openaiApiKey: savedKey };

    assert.equal((await request(other, probePath, 'POST', draft, 'default')).status, 403);
    assert.equal((await request(owner, probePath, 'POST', { ...draft, openaiApiKey: undefined })).status, 400);
    assert.equal((await request(owner, '/api/config', 'PUT', { openaiBaseUrl: 'file:///model' })).status, 400);
    assert.equal(calls.length, 0);
    for (const openaiBaseUrl of [baseUrl, localhostUrl, ipv6Url]) {
      assert.deepEqual(await request(other, probePath, 'POST', { ...draft, openaiBaseUrl }), { status: 200, data: { ok: true } });
      assert.equal(calls.at(-1)?.authorization, `Bearer ${savedKey}`);
    }

    const failed = await request(owner, probePath, 'POST', { ...draft, aiAssignmentModel: 'blocked-model' });
    assert.equal(failed.status, 502);
    assert.doesNotMatch(JSON.stringify(failed.data), new RegExp(savedKey));
    const count = calls.length;
    assert.equal((await request(owner, probePath, 'POST', { ...draft, aiAssignmentModel: 'redirect-model' })).status, 502);
    assert.equal(calls.length, count + 1);
    const slowProbe = once(upstream, 'slow-probe');
    const pending = request(owner, probePath, 'POST', { ...draft, aiAssignmentModel: 'slow-model' });
    const [slowResponse] = await slowProbe as [ServerResponse];
    assert.equal((await request(owner, probePath, 'POST', draft)).status, 409);
    slowResponse.end(JSON.stringify({ output_text: '{"ok":true}' }));
    assert.deepEqual(await pending, { status: 200, data: { ok: true } });

    assert.deepEqual(await request(owner, probePath, 'POST', draft), { status: 200, data: { ok: true } });
    assert.equal(calls.at(-1)?.path, '/v1/responses');
    assert.equal(calls.at(-1)?.body.model, model);
    assert.equal(calls.at(-1)?.authorization, `Bearer ${savedKey}`);
    const before = await request(owner, '/api/bootstrap');
    assert.notEqual(before.data.config?.aiAssignmentModel, model);
    assert.equal(before.data.config?.openaiApiKeySaved, false);
    assert.equal((await request(owner, probePath, 'POST', {})).status, 200);
    assert.equal(calls.at(-1)?.authorization, `Bearer ${envKey}`);

    const saved = await request(owner, '/api/config', 'PUT', draft);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.config?.aiAssignmentCustomModels, [model]);
    assert.equal(saved.data.config?.openaiApiKeySaved, true);
    assert.equal((saved.data.config?.openaiModelConnections as { baseUrl: string }[])[0].baseUrl, baseUrl);
    assert.doesNotMatch(JSON.stringify(saved.data), new RegExp(`${savedKey}|${envKey}`));
    const reselection = await request(owner, '/api/config', 'PUT', { aiAssignmentModel: 'gpt-6-luna' });
    assert.deepEqual(reselection.data.config?.aiAssignmentCustomModels, [model]);
    assert.equal((await request(owner, '/api/config', 'PUT', { aiAssignmentModel: model })).status, 200);
    const beforeOther = await request(other, '/api/bootstrap');
    assert.equal(beforeOther.data.config?.openaiApiKeyConfigured, false);
    assert.equal((await request(other, probePath, 'POST', {})).status, 400);
    const clearedLegacySelection = await request(other, '/api/config', 'PUT', { aiAssignmentModel: '' });
    assert.equal(clearedLegacySelection.status, 200);
    assert.equal(clearedLegacySelection.data.config?.aiAssignmentModel, '');
    assert.deepEqual(clearedLegacySelection.data.config?.openaiModelConnections, beforeOther.data.config?.openaiModelConnections);
    assert.equal((await request(owner, probePath, 'POST', { openaiBaseUrl: 'https://models.example.com/v1' })).status, 400);

    assert.ok(before.data.storageUserKey && app);
    await app.close(); app = undefined;
    const db = openDatabase(rootDir);
    try {
      db.writeSettings('default', { assignmentPeople: [{ name: '小李', employeeId: '42', responsibility: '前端' }] });
      await db.createStore('default').writeUserState(before.data.storageUserKey, {
        bugs: [{ id: 'jira:100', code: 'DEMO-1', title: '前端按钮', status: 'Open', attachmentsLoaded: true }]
      });
    } finally { db.close(); }
    app = await start();
    assert.equal((await request(owner, probePath, 'POST', {})).status, 200);
    assert.equal(calls.at(-1)?.authorization, `Bearer ${savedKey}`);
    assert.equal(calls.at(-1)?.body.model, model);
    const recommended = await request(owner, '/api/bugs/jira%3A100/assignment/recommend', 'POST', {});
    assert.equal(recommended.data.recommendation?.status, 'ready');
    assert.equal(calls.at(-1)?.authorization, `Bearer ${savedKey}`);
    assert.equal(calls.at(-1)?.body.model, model);

    const legacy = (await request(owner, '/api/bootstrap')).data.config;
    const secondaryKey = 'synthetic-second-provider-key';
    const secondaryModel = 'vendor/secondary';
    const first = { baseUrl, models: [model, 'vendor/sibling'], timeoutMs: 30000 };
    const second = { baseUrl: `${ipv6Url}/secondary`, models: [secondaryModel], timeoutMs: 40000, apiKey: secondaryKey };
    const multi = { expectedModelConfigRevision: legacy?.modelConfigRevision, openaiModelConnections: [first, second] };
    assert.equal((await request(owner, '/api/config', 'PUT', { ...multi, openaiModelConnections: [first, { ...second, models: [model] }] })).status, 400);
    assert.equal((await request(owner, '/api/config', 'PUT', { ...multi, openaiModelConnections: [first, { ...second, baseUrl: `${baseUrl}/` }] })).status, 400);
    assert.equal((await request(owner, '/api/config', 'PUT', { ...multi, aiAssignmentModel: 'unbound' })).status, 400);
    const configured = await request(owner, '/api/config', 'PUT', multi);
    assert.equal(configured.status, 200);
    assert.deepEqual(configured.data.config?.openaiModelConnections, [
      { ...first, apiKeyConfigured: true, apiKeySaved: true },
      { baseUrl: second.baseUrl, models: [secondaryModel], timeoutMs: 40000, apiKeyConfigured: true, apiKeySaved: true }
    ]);
    assert.doesNotMatch(JSON.stringify(configured.data), new RegExp(`${savedKey}|${secondaryKey}|${envKey}`));
    assert.equal((await request(owner, '/api/config', 'PUT', multi)).status, 409);
    assert.equal((await request(owner, '/api/config', 'PUT', { openaiBaseUrl: localhostUrl })).status, 400);
    assert.equal((await request(other, '/api/bootstrap')).data.config?.openaiApiKeyConfigured, false);

    for (const [selected, requestPath, key] of [
      ['vendor/sibling', '/v1/responses', savedKey],
      [secondaryModel, '/v1/secondary/responses', secondaryKey],
      [model, '/v1/responses', savedKey]
    ]) {
      assert.equal((await request(owner, '/api/config', 'PUT', { aiAssignmentModel: selected })).status, 200);
      assert.equal((await request(owner, '/api/bugs/jira%3A100/assignment/recommend', 'POST', {})).data.recommendation?.status, 'ready');
      assert.equal(calls.at(-1)?.path, requestPath);
      assert.equal(calls.at(-1)?.body.model, selected);
      assert.equal(calls.at(-1)?.authorization, `Bearer ${key}`);
    }
    assert.equal((await request(owner, probePath, 'POST', { aiAssignmentModel: secondaryModel })).status, 200);
    assert.equal(calls.at(-1)?.authorization, `Bearer ${secondaryKey}`);

    assert.ok(app); await app.close(); app = undefined;
    app = await start();
    const reloaded = (await request(owner, '/api/bootstrap')).data.config;
    assert.deepEqual(reloaded?.openaiModelConnections, configured.data.config?.openaiModelConnections);
    const clearedKey = await request(owner, '/api/config', 'PUT', {
      expectedModelConfigRevision: reloaded?.modelConfigRevision,
      openaiModelConnections: [first, { ...second, apiKey: null }]
    });
    assert.equal(clearedKey.status, 200);
    assert.equal((await request(owner, probePath, 'POST', { aiAssignmentModel: secondaryModel })).status, 400);
    assert.equal((await request(owner, probePath, 'POST', {})).status, 200);
    assert.equal(calls.at(-1)?.authorization, `Bearer ${savedKey}`);
    const removed = await request(owner, '/api/config', 'PUT', {
      expectedModelConfigRevision: clearedKey.data.config?.modelConfigRevision,
      openaiModelConnections: [{ baseUrl: localhostUrl, models: [secondaryModel], timeoutMs: 30000 }]
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.config?.aiAssignmentModel, '');
    assert.equal((await request(owner, probePath, 'POST', { aiAssignmentModel: secondaryModel })).status, 200);
    assert.equal(calls.at(-1)?.authorization, `Bearer ${envKey}`);
    const beforeUnbound = calls.length;
    assert.equal((await request(owner, '/api/bugs/jira%3A100/assignment/recommend', 'POST', {})).data.recommendation?.status, 'error');
    assert.equal(calls.length, beforeUnbound);
  } finally {
    await Promise.all([upstream, ipv6Upstream].map(server => {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      return closed;
    }));
    await app?.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});
