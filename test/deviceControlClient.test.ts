import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readDeviceUpdates, runDeviceControl, watchDeviceUpdates } from '../src/deviceControlClient.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('device notifications tolerate split CRLF frames and release the reader on malformed data', async () => {
  let wakes = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const part of [': keep-alive\r', '\n\r\n', 'event: device-control\r\n', 'data: {"version":12}\r', '\n\r', '\n']) controller.enqueue(encoder.encode(part));
    controller.close();
  } });
  await readDeviceUpdates(new Response(body, { headers: { 'content-type': 'text/event-stream' } }), () => { wakes++; });
  assert.equal(wakes, 1); assert.equal(body.locked, false);
  for (const data of ['{"version":-1}', 'null', '{"version":"1"}', 'bad-json', 'x'.repeat(65_537)]) {
    let cancelled = false;
    const invalid = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(`event: device-control\ndata: ${data}\n\n`)); }, cancel() { cancelled = true; } });
    await assert.rejects(readDeviceUpdates(new Response(invalid, { headers: { 'content-type': 'text/event-stream' } }), () => { assert.fail('invalid event'); }));
    assert.equal(cancelled, true); assert.equal(invalid.locked, false);
  }
});

test('control notifications bypass slow work and coalesce without losing a wake received during work', { timeout: 5000 }, async () => {
  const stop = new AbortController(), entered = deferred(), release = deferred(), control = deferred(), repeated = deferred();
  let wake = () => {}, work = 0, controls = 0;
  const running = runDeviceControl({ signal: stop.signal, pollMs: 60_000,
    async work() { if (++work === 1) { entered.resolve(); await release.promise; } else repeated.resolve(); },
    async controls() { if (++controls === 2) control.resolve(); }, async heartbeat() {}, onError(error) { throw error; },
    async subscribe(notify, signal) { wake = notify; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }
  });
  try {
    await entered.promise;
    for (let i = 0; i < 20; i++) wake();
    await control.promise;
    assert.equal(work, 1, 'control must be processed while work is still blocked');
    release.resolve(); await repeated.promise;
    assert.equal(work, 2, 'many notifications require only one additional pass');
  } finally { release.resolve(); stop.abort(); await running; }
  const completed = controls; await delay(10); assert.equal(controls, completed);
});

test('periodic reconciliation survives missing notifications and transient control failures', { timeout: 5000 }, async () => {
  const stop = new AbortController(), retried = deferred();
  let errors = 0, controls = 0;
  const running = runDeviceControl({ signal: stop.signal, pollMs: 10, heartbeatMs: 10,
    async work() {}, async heartbeat() {},
    async controls() { if (++controls === 1) throw new Error('offline'); retried.resolve(); },
    onError() { errors++; },
    async subscribe(_wake, signal) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }
  });
  await retried.promise; stop.abort(); await running;
  assert.equal(errors, 1); assert.ok(controls >= 2);
});

test('revoked notification credentials stop reconnects', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('{}', { status: 401 }); });
  await assert.rejects(watchDeviceUpdates({ url: new URL('https://workbench.example/device-updates'), token: 'test',
    signal: new AbortController().signal, wake() { assert.fail('unauthorized'); }, onError() { assert.fail('must stop'); } }), { status: 401 });
  assert.equal(requests, 1);
});

test('notification reconnects reconcile even when the version has not advanced', { timeout: 5000 }, async t => {
  const stop = new AbortController();
  let requests = 0, wakes = 0, errors = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response('event: device-control\ndata: {"version":3}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  await watchDeviceUpdates({ url: new URL('https://workbench.example/device-updates'), token: 'test', signal: stop.signal,
    wake() { if (++wakes === 2) stop.abort(); }, onError() { errors++; } });
  assert.equal(requests, 2); assert.equal(wakes, 2); assert.equal(errors, 1);
});

test('aborting the connector cancels a live notification stream', { timeout: 5000 }, async t => {
  const stop = new AbortController(), connected = deferred();
  let connectionSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: URL, options: RequestInit) => {
    connectionSignal = options.signal!;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      options.signal!.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
      connected.resolve();
    } });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  const running = watchDeviceUpdates({ url: new URL('https://workbench.example/device-updates'), token: 'test', signal: stop.signal,
    wake() {}, onError(error) { throw error; } });
  await connected.promise; stop.abort(); await running;
  assert.equal(connectionSignal?.aborted, true);
});
