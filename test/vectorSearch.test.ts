import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, rawDatabase } from '../scripts/testing/database.js';
import { createVectorSearch, searchQuery, vectorSearchEnabled } from '../src/vectorSearch.js';
import { randomUUID } from 'node:crypto';

const environment = { VECTOR_SEARCH_ENABLED: 'true', VECTOR_SEARCH_DIMENSIONS: '3', VECTOR_SEARCH_BASE_URL: 'http://embedding.test/v1', VECTOR_SEARCH_MIN_SCORE: '0.8' };
function fixture(t: TestContext) {
  const key = randomUUID(), database = openDatabase(key);
  for (const id of ['a', 'b']) database.createTenant({ id, token: id.repeat(32) });
  const calls: string[][] = [];
  let broken = false;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const { input } = JSON.parse(String(init?.body)) as { input: string[] };
    calls.push(input);
    if (broken) return Response.json({ error: 'private api-key' }, { status: 503 });
    return Response.json({ data: input.map((text, index) => ({ index, embedding: /登录|身份验证/.test(text) ? [1, 0, 0] : [0, 1, 0] })).reverse() });
  };
  const service = createVectorSearch({ store: database.searchVectors, tenantId: 'a', environment, fetch });
  t.after(async () => { await service.close(); database.close(); });
  return { key, database, service, calls, fetch, fail: (value: boolean) => { broken = value; } };
}
const docs = [{ id: 'semantic', text: '修复登录失败' }, { id: 'literal', text: '身份验证故障' }, { id: 'unrelated', text: '导出报表' }];

test('hybrid search keeps keyword matches first, ranks semantic neighbors and reuses persisted vectors', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.service.search('tasks', '身份验证', docs), { ids: ['literal', 'semantic'], mode: 'hybrid' });
  const count = f.calls.length;
  await Promise.all([f.service.search('tasks', '身份验证', docs), f.service.search('tasks', '身份验证', docs)]);
  assert.equal(f.calls.length, count);
  const restarted = createVectorSearch({ store: f.database.searchVectors, tenantId: 'a', environment, fetch: f.fetch });
  assert.deepEqual((await restarted.search('tasks', '身份验证', docs)).ids, ['literal', 'semantic']);
  assert.equal(f.calls.length, count + 1, 'only the query needs embedding after restart');
  await restarted.close();
});

test('changed content is reindexed, removed documents cannot return, and collections and tenants are isolated', async t => {
  const f = fixture(t);
  await f.service.search('tasks', '身份验证', docs);
  const changed = [{ id: 'semantic', text: '导出报表' }, { id: 'unrelated', text: '导出报表' }];
  assert.deepEqual((await f.service.search('tasks', '身份验证', changed)).ids, []);
  const other = createVectorSearch({ store: f.database.searchVectors, tenantId: 'b', environment, fetch: f.fetch });
  assert.deepEqual((await other.search('tasks', '身份验证', [{ id: 'private', text: '修复登录失败' }])).ids, ['private']);
  assert.deepEqual((await f.service.search('bugs', '身份验证', changed)).ids, []);
  assert.deepEqual((await f.service.search('tasks', '身份验证', changed)).ids, []);
  await other.close();
});

test('model and dimension profiles never compare incompatible vectors', async t => {
  const f = fixture(t);
  await f.service.search('tasks', '身份验证', docs);
  const other = createVectorSearch({ store: f.database.searchVectors, tenantId: 'a', environment: { ...environment, VECTOR_SEARCH_MODEL: 'other', VECTOR_SEARCH_DIMENSIONS: '2' },
    fetch: async (_url, init) => {
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) });
    } });
  assert.equal((await other.search('tasks', '身份验证', docs)).mode, 'hybrid');
  assert.deepEqual((await f.service.search('tasks', '身份验证', docs)).ids, ['literal', 'semantic']);
  await other.close();
});

test('upstream failure is explicit, never leaks provider errors, and a later search recovers', async t => {
  const f = fixture(t); f.fail(true);
  const result = await f.service.search('tasks', '身份验证', docs);
  assert.equal(result.mode, 'keyword'); assert.deepEqual(result.ids, ['literal']); assert.match(result.warning!, /暂不可用/);
  assert.ok(!JSON.stringify(result).includes('api-key'));
  f.fail(false);
  assert.equal((await f.service.search('tasks', '身份验证', docs)).mode, 'hybrid');
});

test('invalid embedding responses cannot poison the index', async t => {
  const f = fixture(t);
  for (const embedding of [[0, 0, 0], [1, 2], [null, 1, 0], [1e100, 0, 0]]) {
    const invalid = createVectorSearch({ store: f.database.searchVectors, tenantId: 'a', environment,
      fetch: async () => Response.json({ data: [{ index: 0, embedding }] }) });
    assert.equal((await invalid.search('tasks', '身份验证', [docs[0]])).mode, 'keyword');
    await invalid.close();
  }
  const raw = rawDatabase(f.key);
  assert.equal(raw.prepare('SELECT count(*) AS total FROM search_vectors').get()?.total, 0); raw.close();
});

test('empty and disabled searches never call a provider and reject excessive input', async t => {
  const f = fixture(t);
  assert.deepEqual((await f.service.search('tasks', '', docs)).ids, docs.map(doc => doc.id));
  const disabled = createVectorSearch({ store: f.database.searchVectors, tenantId: 'a', environment: { VECTOR_SEARCH_ENABLED: 'false' }, fetch: f.fetch });
  assert.deepEqual(await disabled.search('tasks', '身份验证', docs), { ids: ['literal'], mode: 'keyword' });
  assert.equal(f.calls.length, 0);
  assert.throws(() => searchQuery(new URLSearchParams({ q: 'x'.repeat(201) })), { statusCode: 400 });
  await disabled.close();
});

test('concurrent duplicate searches share committed indexing, and shutdown cancels pending network work', async t => {
  const f = fixture(t);
  await Promise.all([f.service.search('tasks', '身份验证', docs), f.service.search('tasks', '身份验证', docs)]);
  assert.equal(f.calls.length, 2);
  let started!: () => void;
  const gate = new Promise<void>(resolve => { started = resolve; });
  const pending = createVectorSearch({ store: f.database.searchVectors, tenantId: 'a', environment,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); started();
    }) });
  const result = pending.search('bugs', '身份验证', docs);
  await gate; await pending.close();
  assert.match((await result).warning!, /暂不可用/);
});

test('chunking finds matches late in long documents and commits complete documents atomically', async t => {
  const f = fixture(t);
  const result = await f.service.search('tasks', '身份验证', [{ id: 'long', text: '报表'.repeat(1000) + '修复登录' }]);
  assert.deepEqual(result.ids, ['long']);
  assert.equal(f.calls[0].length, 2);
});

test('version 7 migrates existing tenants without changing task data', t => {
  const f = fixture(t), before = f.database.readTaskCenter('a');
  const raw = rawDatabase(f.key);
  raw.prepare('DROP TABLE search_vectors').run(); raw.prepare('DELETE FROM schema_migrations WHERE version >= 7').run(); raw.close();
  const upgraded = openDatabase(f.key);
  assert.deepEqual(upgraded.readTaskCenter('a'), before);
  assert.equal(upgraded.searchVectors.indexed('a', 'tasks', 'profile').size, 0);
  upgraded.close();
});

test('defect descriptions participate in semantic retrieval without changing keyword fields', async t => {
  const f = fixture(t);
  const { bugSearchDocuments } = await import('../src/searchDocuments.js');
  const documents = bugSearchDocuments([{ id: 'bug', aid: '1', code: 'BUG-1', title: '无法进入工作台', description: '登录失败',
    status: 'open', priority: '', severity: '', assignee: '', assigneeId: '', product: '', category: '', createdAt: '', updatedAt: '' }]);
  assert.deepEqual((await f.service.search('bugs', '身份验证', documents)).ids, ['bug']);
  const disabled = createVectorSearch({ store: f.database.searchVectors, tenantId: 'a', environment: { VECTOR_SEARCH_ENABLED: 'false' }, fetch: f.fetch });
  assert.deepEqual((await disabled.search('bugs', '登录', documents)).ids, []);
  await disabled.close();
});

test('bounded indexing reports partial coverage and resumes on the next search', async t => {
  const f = fixture(t);
  const documents = [...Array.from({ length: 100 }, (_, index) => ({ id: `report-${index}`, text: '导出报表' })), docs[0]];
  const first = await f.service.search('tasks', '身份验证', documents);
  assert.equal(first.mode, 'hybrid'); assert.match(first.warning!, /尚未完成/); assert.deepEqual(first.ids, []);
  const second = await f.service.search('tasks', '身份验证', documents);
  assert.deepEqual(second.ids, ['semantic']); assert.equal(second.warning, undefined);
});

test('embedding configuration follows tenant environment isolation', async t => {
  const { tenantEnvironment } = await import('../src/tenancy.js');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'vector-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { TENANT_ENV_DIR: root, VECTOR_SEARCH_ENABLED: 'true', VECTOR_SEARCH_API_KEY: 'default-only', VECTOR_SEARCH_MODEL: 'default-model' };
  assert.equal(tenantEnvironment({ id: 'default' }, root, env).VECTOR_SEARCH_API_KEY, 'default-only');
  assert.equal(tenantEnvironment({ id: 'other' }, root, env).VECTOR_SEARCH_API_KEY, undefined);
  assert.equal(tenantEnvironment({ id: 'other' }, root, env).VECTOR_SEARCH_ENABLED, undefined);
  await writeFile(path.join(root, 'other.env'), 'VECTOR_SEARCH_ENABLED=true\nVECTOR_SEARCH_API_KEY=other-only\nVECTOR_SEARCH_MODEL=other-model\n');
  const other = tenantEnvironment({ id: 'other' }, root, env);
  assert.equal(other.VECTOR_SEARCH_API_KEY, 'other-only'); assert.equal(other.VECTOR_SEARCH_MODEL, 'other-model');
});


test('vector search defaults on, supports explicit opt-out, and reports missing service configuration', async t => {
  const f = fixture(t);
  assert.equal(vectorSearchEnabled({}), true);
  for (const value of ['false', '0', 'no', 'off', ' FALSE ']) assert.equal(vectorSearchEnabled({ VECTOR_SEARCH_ENABLED: value }), false);
  const { VECTOR_SEARCH_ENABLED: _flag, ...defaults } = environment;
  const service = createVectorSearch({ store: f.database.searchVectors, tenantId: 'a', environment: defaults, fetch: f.fetch });
  assert.equal((await service.search('tasks', '身份验证', docs)).mode, 'hybrid');
  await service.close();
  const unconfigured = createVectorSearch({ store: f.database.searchVectors, tenantId: 'a', environment: {}, fetch: f.fetch });
  const calls = f.calls.length;
  const result = await unconfigured.search('tasks', '身份验证', docs);
  assert.equal(result.mode, 'keyword'); assert.match(result.warning!, /暂不可用/);
  assert.equal(f.calls.length, calls);
  await unconfigured.close();
});
