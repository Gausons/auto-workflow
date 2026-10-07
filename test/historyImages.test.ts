import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHistoryImages, prepareSessionImage, validateSessionImage } from '../src/historyImages.js';
import { createTaskCenter } from '../src/taskCenter.js';
import { createAgentHistory } from '../src/agentHistory/index.js';
import { syncDeviceOnce } from '../src/deviceConnector.js';
import { createApp, openDatabase, rawDatabase } from '../scripts/testing/database.js';
import type { SessionImageList } from '../shared/historyImageTypes.js';

const dataUrl = 'data:image/png;base64,' + Buffer.alloc(900_000, 1).toString('base64');
const image = prepareSessionImage(1, 0, '查看截图', { dataUrl, alt: '原始截图' });
const preview = { offset: 85, total: 115, sourcePartial: false, truncated: false, messages: [{ role: 'assistant', text: '完成' }] };
const heartbeat = { action: 'heartbeat', deviceId: 'source', name: '来源设备', agents: ['codex'], sessions: [{ nativeId: 'native', agent: 'codex', title: '图片会话', remoteHistory: preview }] };
const upload = { deviceId: 'source', nativeId: 'native', agent: 'codex', image };
const actor = { id: 'owner' };
const emptyHistory = { catalog: async () => ({ providers: [], sessions: [] }) };

test('image writes preserve original data, isolate sessions and tenants, and serialize duplicates and conflicts', async t => {
  const key = randomUUID(), db = openDatabase(key), raw = rawDatabase(key);
  t.after(() => { raw.close(); db.close(); });
  for (const id of ['default', 'other']) db.createTenant({ id, token: id.repeat(40) });
  const center = createTaskCenter({ database: db, tenantId: 'default', history: emptyHistory });
  const service = createHistoryImages(db, 'default');
  await center.command(heartbeat, actor);
  const id = db.readTaskCenter('default').sessions[0].id;
  assert.throws(() => service.upload(upload, { id: 'another-owner' }), { statusCode: 403 });
  assert.throws(() => createHistoryImages(db, 'other').upload(upload, actor), { statusCode: 403 });
  assert.throws(() => service.upload({ ...upload, nativeId: 'another-session' }, actor), { statusCode: 404 });
  assert.throws(() => service.upload({ ...upload, image: prepareSessionImage(116, 0, '', { dataUrl }) }, actor), { statusCode: 409 });
  await Promise.all([1, 2].map(() => Promise.resolve().then(() => service.upload(upload, actor))));
  assert.equal(service.read(id, image.id).dataUrl, dataUrl);
  const revision = () => raw.prepare('SELECT xmin::text AS revision FROM remote_session_images').get()?.revision;
  const before = revision(); service.upload(upload, actor);
  assert.equal(revision(), before);
  raw.prepare('UPDATE remote_session_images SET byte_length = ?').run(50 * 1024 * 1024);
  assert.throws(() => service.upload({ ...upload, image: prepareSessionImage(2, 0, '', { dataUrl }) }, actor), { statusCode: 413 });
  assert.equal(service.list(id, new URLSearchParams()).total, 1, 'quota failures must leave committed images intact');
  raw.prepare('UPDATE remote_session_images SET byte_length = ?').run(900000);
  const conflict = { ...upload, image: prepareSessionImage(1, 0, 'changed', { dataUrl }) };
  assert.throws(() => service.upload(conflict, actor), { statusCode: 409 });
  assert.equal(service.list(id, new URLSearchParams()).total, 1);
  assert.equal(JSON.stringify(service.list(id, new URLSearchParams())).includes('base64'), false);
  assert.equal(JSON.stringify(db.readTaskCenter('default')).includes('base64'), false);
  assert.equal(db.readTaskCenter('default').sessions[0].syncedImageCount, 1);
  assert.throws(() => createHistoryImages(db, 'other').read(id, image.id), { statusCode: 404 });
  assert.throws(() => service.read('a'.repeat(64), image.id), { statusCode: 404 });
  await center.command({ ...heartbeat, sessions: [{ ...heartbeat.sessions[0], nativeId: 'second' }] }, actor);
  const second = db.readTaskCenter('default').sessions.find(session => session.nativeId === 'second')!;
  assert.throws(() => service.read(second.id, image.id), { statusCode: 404 });
  assert.throws(() => service.list(id, new URLSearchParams({ limit: '51' })), { statusCode: 400 });
  await center.command(heartbeat, actor);
  assert.equal(db.readTaskCenter('default').sessions[0].syncedImageCount, 1);
  await center.command({ ...heartbeat, sessions: [{ ...heartbeat.sessions[0], remoteHistory: undefined }] }, actor);
  assert.equal(db.readRemoteSessionImage('default', id, image.id), null);
  assert.throws(() => service.upload(upload, actor), { statusCode: 404 });
});

test('image validation rejects unsafe formats, oversized data and altered metadata', () => {
  assert.deepEqual(validateSessionImage(image), image);
  for (const invalid of [
    { ...image, id: 'a'.repeat(64) }, { ...image, record: 0 }, { ...image, index: -1 },
    { ...image, alt: '\u0000' }, { ...image, text: 'x'.repeat(1001) },
    prepareSessionImage(1, 0, '', { dataUrl: 'https://example.com/image.png' }),
    prepareSessionImage(1, 0, '', { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }),
    prepareSessionImage(1, 0, '', { dataUrl: 'data:image/png;base64,' + 'A'.repeat(16 * 1024 * 1024 + 4) })
  ]) assert.throws(() => validateSessionImage(invalid), { statusCode: 400 });
});

test('image uploads select synced history when workbench sessions share its native identity', async t => {
  for (const source of ['conversation', 'agentExecution', 'codexExecution'] as const) {
    for (const workbenchFirst of [true, false]) {
      await t.test(`${source}, workbench first: ${workbenchFirst}`, async t => {
        const db = openDatabase(); t.after(() => db.close());
        db.createTenant({ id: 'default', token: 'x'.repeat(40) });
        const center = createTaskCenter({ database: db, tenantId: 'default', history: emptyHistory });
        const service = createHistoryImages(db, 'default');
        await center.command(heartbeat, actor);
        const synced = db.readTaskCenter('default').sessions[0];
        const workbench = { ...synced, id: randomUUID(), source, recordMode: undefined, syncedRange: undefined };
        db.mutateTaskCenter('default', data => {
          if (workbenchFirst) data.sessions.unshift(workbench); else data.sessions.push(workbench);
        });

        assert.deepEqual(service.upload(upload, actor), { id: image.id });
        assert.deepEqual(service.upload(upload, actor), { id: image.id });
        assert.equal(service.read(synced.id, image.id).dataUrl, dataUrl);
        assert.equal(service.list(synced.id, new URLSearchParams()).total, 1);
        assert.equal(db.listRemoteSessionImages('default', workbench.id).total, 0);
        const sessions = db.readTaskCenter('default').sessions;
        assert.equal(sessions.find(session => session.id === synced.id)?.syncedImageCount, 1);
        assert.deepEqual(sessions.find(session => session.id === workbench.id), JSON.parse(JSON.stringify(workbench)));

        await center.command({ ...heartbeat, sessions: [{ ...heartbeat.sessions[0], remoteHistory: undefined }] }, actor);
        assert.throws(() => service.upload(upload, actor), { statusCode: 404 });
        assert.equal(db.listRemoteSessionImages('default', synced.id).total, 0);
        assert.equal(db.listRemoteSessionImages('default', workbench.id).total, 0);
      });
    }
  }
});

test('connector uploads images before the preview window and retries only missing objects without backfilling unchanged sessions', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'history-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'sessions'); await mkdir(source);
  const rows = [{ type: 'session_meta', payload: { id: 'native', cwd: root } },
    ...Array.from({ length: 115 }, (_, i) => ({ type: 'response_item', timestamp: '2026-10-05T00:00:00Z', payload: {
      type: 'message', role: i === 0 || i === 81 ? 'user' : 'assistant', content: [{ type: 'input_text', text: `记录 ${i + 1}` },
        ...([0, 81].includes(i) ? [{ type: 'input_image', image_url: dataUrl }] : [])] } }))];
  await writeFile(path.join(source, 'session.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  const history = createAgentHistory({ environment: { IDE_HISTORY_CODEX_DIR: source, IDE_HISTORY_CLAUDE_DIR: path.join(root, 'absent') } });
  const db = openDatabase(); t.after(() => db.close()); db.createTenant({ id: 'default', token: 'x'.repeat(40) });
  const center = createTaskCenter({ database: db, tenantId: 'default', history: emptyHistory });
  const service = createHistoryImages(db, 'default'), uploads: number[] = [];
  let fail = true;
  const request = async (method: string, body?: unknown, endpoint?: string) => {
    if (endpoint?.startsWith('/api/agent-sessions/')) {
      const url = new URL(endpoint, 'http://test'); return service.list(url.pathname.split('/')[3], url.searchParams);
    }
    if (endpoint === '/api/task-center/history-images') {
      const input = body as typeof upload; uploads.push(input.image.record);
      if (input.image.record === 82 && fail) { fail = false; throw new Error('模拟断网'); }
      return service.upload(input, actor);
    }
    return method === 'POST' ? center.command(body, actor) : center.snapshot();
  };
  const index: Record<string, string> = {};
  const options = { request, history, deviceId: 'source', name: '来源', outputDir: path.join(root, 'inbox'), includeExcerpts: true, sessionIndex: index };
  await assert.rejects(syncDeviceOnce(options), /模拟断网/);
  assert.deepEqual(index, {});
  await syncDeviceOnce(options);
  assert.deepEqual(uploads, [1, 82, 82]);
  const session = db.readTaskCenter('default').sessions[0];
  assert.equal(session.syncedImageCount, 2);
  assert.equal(session.syncedRange?.offset, 85);
  assert.equal(db.readRemoteSessionHistory('default', session.id)?.messages.length, 30);
  const list = service.list(session.id, new URLSearchParams());
  assert.deepEqual(list.images.map(image => image.record), [1, 82]);
  assert.equal(service.read(session.id, list.images[0].id).dataUrl, dataUrl);
  await syncDeviceOnce({ ...options, history: { ...history, images: async () => { throw new Error('不应回填'); } } });
  assert.deepEqual(uploads, [1, 82, 82]);
  await syncDeviceOnce({ ...options, includeExcerpts: false });
  assert.equal(db.listRemoteSessionImages('default', session.id).total, 0);
});

test('connector separates forks, selects the newest duplicate source and defers images appended after the heartbeat', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'history-image-forks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'sessions'); await mkdir(source);
  const imageUrl = 'data:image/png;base64,aGVsbG8=';
  const meta = (id: string) => ({ type: 'session_meta', timestamp: '2026-10-05T00:00:00Z', payload: { id, cwd: root } });
  const message = (text: string, withImage = false) => ({ type: 'response_item', timestamp: '2026-10-05T00:00:00Z', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text }, ...(withImage ? [{ type: 'input_image', image_url: imageUrl }] : [])]
  } });
  const parentFile = path.join(source, 'parent.jsonl');
  await writeFile(parentFile, [meta('parent'), message('第一条'), message('父会话图片', true)].map(row => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(path.join(source, 'child.jsonl'), [meta('child'), meta('parent'), message('子会话图片', true)].map(row => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(path.join(source, 'older-parent.jsonl'), [meta('parent'), message('旧记录')].map(row => JSON.stringify({ ...row, timestamp: '2026-10-04T00:00:00Z' })).join('\n') + '\n');
  const history = createAgentHistory({ environment: { IDE_HISTORY_CODEX_DIR: source, IDE_HISTORY_CLAUDE_DIR: path.join(root, 'absent') } });
  const db = openDatabase(); t.after(() => db.close()); db.createTenant({ id: 'default', token: 'x'.repeat(40) });
  const center = createTaskCenter({ database: db, tenantId: 'default', history: emptyHistory });
  const service = createHistoryImages(db, 'default');
  const uploads: Array<{ nativeId: string; record: number }> = [];
  const heartbeats: string[][] = [];
  let append = true;
  const request = async (method: string, body?: unknown, endpoint?: string) => {
    if (endpoint?.startsWith('/api/agent-sessions/')) {
      const url = new URL(endpoint, 'http://test'); return service.list(url.pathname.split('/')[3], url.searchParams);
    }
    if (endpoint === '/api/task-center/history-images') {
      const input = body as typeof upload;
      uploads.push({ nativeId: input.nativeId, record: input.image.record });
      return service.upload(input, actor);
    }
    if (method === 'GET') return center.snapshot();
    heartbeats.push((body as typeof heartbeat).sessions.map(session => session.nativeId));
    const result = await center.command(body, actor);
    if (append) { append = false; await appendFile(parentFile, JSON.stringify(message('同步期间新增的图片', true)) + '\n'); }
    return result;
  };
  const index: Record<string, string> = {};
  const options = { request, history, deviceId: 'source', name: '来源', outputDir: path.join(root, 'inbox'), includeExcerpts: true, sessionIndex: index };
  await syncDeviceOnce(options);
  assert.deepEqual(heartbeats[0].slice().sort(), ['child', 'parent']);
  const sessions = db.readTaskCenter('default').sessions;
  assert.deepEqual(sessions.map(session => session.nativeId).sort(), ['child', 'parent']);
  const parent = sessions.find(session => session.nativeId === 'parent')!;
  const child = sessions.find(session => session.nativeId === 'child')!;
  assert.equal(parent.syncedRange?.total, 2);
  assert.equal(child.syncedRange?.total, 1);
  assert.deepEqual(service.list(parent.id, new URLSearchParams()).images.map(image => image.record), [2]);
  assert.deepEqual(service.list(child.id, new URLSearchParams()).images.map(image => image.record), [1]);
  assert.deepEqual(Object.keys(index).sort(), ['codex\0child', 'codex\0parent']);
  await syncDeviceOnce(options);
  assert.equal(db.readTaskCenter('default').sessions.find(session => session.id === parent.id)?.syncedRange?.total, 3);
  assert.deepEqual(service.list(parent.id, new URLSearchParams()).images.map(image => image.record), [2, 3]);
  assert.deepEqual(uploads.filter(upload => upload.nativeId === 'parent').map(upload => upload.record), [2, 3]);
  const before = uploads.length;
  await syncDeviceOnce(options);
  assert.equal(uploads.length, before, 'unchanged records must not repeat image uploads');
  assert.deepEqual(heartbeats.at(-1), [], 'older duplicate files must not replace an unchanged latest source');
});

test('image HTTP routes enforce authentication and read/write roles, and read full-size images outside the preview', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'history-image-api-')); t.after(() => rm(root, { recursive: true, force: true }));
  const app = createApp({ rootDir: root, environment: { ACP_ENABLED: 'false', CODEX_EXECUTABLE: path.join(root, 'absent'), IDE_HISTORY_CODEX_DIR: path.join(root, 'absent'), IDE_HISTORY_CLAUDE_DIR: path.join(root, 'absent') } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); t.after(() => app.close());
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const request = (endpoint: string, token?: string, body?: unknown) => fetch(`http://127.0.0.1:${address.port}${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const password = 'Image-Test-Password-2026';
  const owner = await (await request('/api/auth/register', undefined, { username: 'image-owner', password })).json() as { token: string };
  await request('/api/organization/members', owner.token, { username: 'image-viewer', password, role: 'viewer' });
  const viewer = await (await request('/api/auth/login', undefined, { username: 'image-viewer', password })).json() as { token: string };
  const other = await (await request('/api/auth/register', undefined, { username: 'image-other', password })).json() as { token: string };
  assert.equal((await request('/api/task-center', owner.token, heartbeat)).status, 200);
  assert.equal((await request('/api/task-center/history-images', undefined, upload)).status, 401);
  assert.equal((await request('/api/task-center/history-images', viewer.token, upload)).status, 403);
  assert.equal((await request('/api/task-center/history-images', other.token, upload)).status, 403);
  assert.ok(Buffer.byteLength(JSON.stringify(upload)) > 1_000_000, 'original images use a dedicated limit above the heartbeat body cap');
  assert.equal((await request('/api/task-center/history-images', owner.token, upload)).status, 200);
  const state = await (await request('/api/task-center', owner.token)).json() as { sessions: Array<{ id: string }> };
  const url = `/api/agent-sessions/${state.sessions[0].id}/images`;
  assert.equal((await request(url)).status, 401);
  assert.equal((await request(url, other.token)).status, 404);
  const listed = await (await request(url, viewer.token)).json() as SessionImageList;
  assert.equal(listed.total, 1); assert.equal(JSON.stringify(listed).includes('base64'), false);
  const result = await request(`${url}/${image.id}`, viewer.token);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal((await result.json() as { dataUrl: string }).dataUrl, dataUrl);
  assert.equal((await request(`${url}/${'a'.repeat(64)}`, viewer.token)).status, 404);
});
