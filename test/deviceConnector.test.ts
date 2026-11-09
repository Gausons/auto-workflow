import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { deviceConnectorDefaults, deviceStateDirectory, resolveDeviceStateDirectory } from '../scripts/device-sync.js';
import { runDeviceConnector } from '../src/deviceConnector.js';

test('device connector defaults to the user home with execution and excerpts enabled', () => {
  assert.deepEqual(deviceConnectorDefaults({}), {
    execute: true,
    includeExcerpts: true,
    workspace: homedir()
  });
  assert.deepEqual(deviceConnectorDefaults({
    CODEX_WORKSPACE_DIR: '/work',
    WORKBENCH_EXECUTE_CODEX: 'false',
    WORKBENCH_SYNC_EXCERPTS: 'false'
  }), {
    execute: false,
    includeExcerpts: false,
    workspace: '/work'
  });
});

test('default device state is stable per server and account and isolated across connections', () => {
  const first = { origin: 'https://one.example.com', tenantId: 'team', userId: 'owner' };
  const same = deviceStateDirectory({}, first);
  assert.equal(deviceStateDirectory({}, first), same);
  assert.notEqual(deviceStateDirectory({}, { ...first, origin: 'https://two.example.com' }), same);
  assert.notEqual(deviceStateDirectory({}, { ...first, userId: 'other' }), same);
  assert.match(same, new RegExp(`^${path.resolve('.workflow-data', 'devices').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${path.sep}`));
  assert.equal(deviceStateDirectory({ WORKBENCH_DEVICE_DIR: './custom-device' }, first), path.resolve('./custom-device'));
});

test('matching legacy state is preserved while another server receives an isolated directory', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'device-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = { origin: 'https://one.example.com', tenantId: 'team', userId: 'owner' };
  const legacy = path.join(root, '.workflow-data', 'device');
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, 'connection.json'), JSON.stringify(first));
  assert.equal(await resolveDeviceStateDirectory({}, first, root), legacy);
  assert.equal(await resolveDeviceStateDirectory({}, { ...first, origin: 'https://two.example.com' }, root), deviceStateDirectory({}, { ...first, origin: 'https://two.example.com' }, root));
});

test('startup survives unavailable identity and initial heartbeat without changing device identity or credentials', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'device-reconnect-'));
  const stop = new AbortController();
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  t.mock.method(console, 'log', () => {});
  let identities = 0, heartbeats = 0, ready = 0, released = 0;
  const ids: unknown[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer private-token');
    if (req.url === '/api/auth/session') {
      if (++identities === 1) { res.writeHead(503); res.end('<html>proxy unavailable</html>'); return; }
      res.end(JSON.stringify({ tenant: { id: 'tenant' }, user: { id: 'owner' }, permissions: ['work.execute'] })); return;
    }
    assert.equal(req.url, '/api/task-center'); assert.equal(req.method, 'POST');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { deviceId: string; action: string };
    assert.equal(body.action, 'heartbeat'); ids.push(body.deviceId);
    if (++heartbeats === 1) { res.writeHead(503); res.end(JSON.stringify({ message: 'private-token private-password unavailable' })); return; }
    res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { stop.abort(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); await rm(root, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  await runDeviceConnector({ signal: stop.signal, environment: {
    WORKBENCH_URL: `http://127.0.0.1:${address.port}`, WORKBENCH_TOKEN: 'private-token', WORKBENCH_PASSWORD: 'private-password',
    WORKBENCH_DEVICE_DIR: root, WORKBENCH_EXECUTE_CODEX: 'false', IDE_HISTORY_CODEX_DIR: root, IDE_HISTORY_CLAUDE_DIR: root
  }, async onStateDirectory() { return async () => { released++; }; }, onReady() { ready++; stop.abort(); } });
  assert.equal(identities, 2); assert.equal(heartbeats, 2); assert.equal(ready, 1); assert.equal(released, 1);
  assert.equal(ids[0], ids[1]); assert.equal(ids[0], await readFile(path.join(root, 'id'), 'utf8'));
  assert.equal(warnings.length, 2);
  assert.doesNotMatch(warnings.join('\n'), /private-token|private-password/);
  assert.match(warnings.join('\n'), /自动重连/);
});

test('startup identity rejection and one-shot failures stop without retrying or announcing readiness', async t => {
  for (const status of [401, 403, 503]) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('<html>unavailable</html>', { status }); });
    await assert.rejects(runDeviceConnector({ once: status === 503,
      environment: { WORKBENCH_URL: 'https://fixture.invalid', WORKBENCH_TOKEN: 'fixture', WORKBENCH_EXECUTE_CODEX: 'false' },
      onReady() { assert.fail('not connected'); }, onStateDirectory() { assert.fail('not authenticated'); }
    }), { status });
    assert.equal(calls, 1);
  }
});

test('stopping during identity lookup aborts the request without starting a replacement connection', async t => {
  const stop = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      stop.abort();
    });
  });
  await assert.rejects(runDeviceConnector({ signal: stop.signal,
    environment: { WORKBENCH_URL: 'https://fixture.invalid', WORKBENCH_TOKEN: 'fixture' },
    onReady() { assert.fail('not connected'); }, onStateDirectory() { assert.fail('not authenticated'); }
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
