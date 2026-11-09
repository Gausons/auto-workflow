import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { realtimeProtocol, type SendExecutionFeedback } from '../shared/realtime.js';
import { setTimeout as delay } from 'node:timers/promises';
import { connectDeviceUpdates, runDeviceControl, watchDeviceUpdates } from '../src/deviceControlClient.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function socketServer(t: import('node:test').TestContext, connected: (socket: ServerSocket) => void) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (socket, req) => { assert.equal(req.headers['sec-websocket-protocol'], realtimeProtocol); connected(socket); });
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return new URL(`ws://127.0.0.1:${address.port}/api/realtime`);
}

test('device WebSocket authenticates in its first frame, handles heartbeat and reports with acknowledgments', { timeout: 5000 }, async t => {
  const stop = new AbortController();
  let feedback: SendExecutionFeedback | undefined, pongs = 0, reports = 0;
  const url = await socketServer(t, socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString()) as { type: string; token?: string; channel?: string; deviceId?: string; id?: string; input?: { report?: unknown } };
    if (message.type === 'subscribe') {
      assert.equal(message.token, 'fixture-token'); assert.equal(message.channel, 'device-control'); assert.equal(message.deviceId, 'remote');
      socket.send(JSON.stringify({ type: 'ready', channel: 'device-control' }));
      socket.send(JSON.stringify({ type: 'heartbeat' }));
    } else if (message.type === 'pong') pongs++;
    else if (message.type === 'execution-report') {
      if (++reports === 1) assert.deepEqual(message.input?.report, { status: 'running', output: '中文😀' });
      else assert.equal((message.input?.report as { output: string }).output.length, 400_000);
      socket.send(JSON.stringify({ type: 'report-ack', id: message.id, status: 200 }));
    }
  }));
  const ready = deferred();
  const running = connectDeviceUpdates({ url, token: 'fixture-token', deviceId: 'remote', signal: stop.signal, wake() {},
    onFeedback(send) { feedback = send; if (send) ready.resolve(); } });
  await ready.promise; assert.ok(feedback);
  await feedback({ executionId: 'execution', report: { status: 'running', output: '中文😀' } });
  await feedback({ executionId: 'execution', report: { status: 'running', output: '中文'.repeat(200_000) } });
  await assert.rejects(feedback({ executionId: 'execution', report: { status: 'running', output: 'x'.repeat(8_000_000) } }), /超过 8 MB/);
  assert.equal(reports, 2);
  assert.equal(pongs, 1); stop.abort(); await running; assert.equal(feedback, undefined);
});

test('malformed device notifications reject without waking the worker', { timeout: 5000 }, async t => {
  const url = await socketServer(t, socket => socket.once('message', () => socket.send(JSON.stringify({ type: 'device-control', version: -1 }))));
  await assert.rejects(connectDeviceUpdates({ url, token: 'test', deviceId: 'remote', signal: new AbortController().signal,
    wake() { assert.fail('invalid version'); } }), /实时同步版本无效/);
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

test('reconnecting immediately republishes device presence without waiting for the heartbeat interval', { timeout: 5000 }, async () => {
  const stop = new AbortController(), first = deferred(), restored = deferred();
  let wake = () => {}, heartbeats = 0;
  const running = runDeviceControl({ signal: stop.signal, heartbeatMs: 60_000, pollMs: 60_000,
    async work() {}, async controls() {},
    async heartbeat() { if (++heartbeats === 1) first.resolve(); else restored.resolve(); },
    onError(error) { throw error; },
    async subscribe(notify, signal) { wake = notify; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }
  });
  try {
    await first.promise;
    wake();
    await restored.promise;
    assert.equal(heartbeats, 2);
  } finally { stop.abort(); await running; }
});

test('revoked WebSocket credentials stop reconnects', { timeout: 5000 }, async t => {
  let connections = 0;
  const url = await socketServer(t, socket => { connections++; socket.once('message', () => socket.send(JSON.stringify({ type: 'error', status: 401, message: 'expired' }))); });
  await assert.rejects(watchDeviceUpdates({ url, token: 'test', deviceId: 'remote',
    signal: new AbortController().signal, wake() { assert.fail('unauthorized'); }, onError() { assert.fail('must stop'); } }), { status: 401 });
  assert.equal(connections, 1);
});

test('reconnects reconcile the same version and do not replay a lost report acknowledgment internally', { timeout: 5000 }, async t => {
  const stop = new AbortController(), reportSent = deferred();
  let connections = 0, errors = 0, reports = 0;
  let result: Promise<void> | undefined;
  const url = await socketServer(t, socket => {
    connections++;
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as { type: string };
      if (message.type === 'subscribe') socket.send(JSON.stringify({ type: 'ready', channel: 'device-control' }));
      if (message.type === 'execution-report') { reports++; socket.terminate(); reportSent.resolve(); }
    });
  });
  const running = watchDeviceUpdates({ url, token: 'test', deviceId: 'remote', signal: stop.signal, wake() {},
    onFeedback(send) {
      if (!send) return;
      if (connections === 1) { result = send({ executionId: 'execution', report: { status: 'running' } }); void result.catch(() => {}); }
      else stop.abort();
    }, onError() { errors++; } });
  try {
    await reportSent.promise; assert.ok(result); await assert.rejects(result, /断开|连接失败/);
    await running; assert.equal(connections, 2); assert.equal(reports, 1); assert.equal(errors, 1);
  } finally { stop.abort(); await running; }
});

test('aborting the connector closes its live WebSocket', { timeout: 5000 }, async t => {
  const stop = new AbortController(), ready = deferred(), closed = deferred();
  const url = await socketServer(t, socket => { socket.once('close', closed.resolve); socket.once('message', () => socket.send(JSON.stringify({ type: 'ready', channel: 'device-control' }))); });
  const running = connectDeviceUpdates({ url, token: 'test', deviceId: 'remote', signal: stop.signal, wake() { ready.resolve(); } });
  await ready.promise; stop.abort(); await running; await closed.promise;
});

test('a missing report acknowledgment closes the stale connection and rejects all pending reports', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stop = new AbortController(), ready = deferred(), closed = deferred();
  let feedback: SendExecutionFeedback | undefined;
  const url = await socketServer(t, socket => {
    socket.once('close', closed.resolve);
    socket.once('message', () => socket.send(JSON.stringify({ type: 'ready', channel: 'device-control' })));
  });
  const running = connectDeviceUpdates({ url, token: 'test', deviceId: 'remote', signal: stop.signal, wake() {},
    onFeedback(send) { feedback = send; if (send) ready.resolve(); } });
  const disconnected = assert.rejects(running, /确认超时/);
  try {
    await ready.promise; assert.ok(feedback);
    const reports = [1, 2].map(id => assert.rejects(feedback!({ executionId: String(id), report: { status: 'running' } }), /确认超时/));
    t.mock.timers.tick(15000);
    await Promise.all([...reports, disconnected]);
    assert.equal(feedback, undefined);
    await closed.promise;
  } finally { stop.abort(); await disconnected; }
});

test('flapping WebSockets retain backoff until a connection has stayed stable', { timeout: 10000 }, async t => {
  const stop = new AbortController(), sockets: ServerSocket[] = [], attempts: number[] = [];
  const clock = Date.now;
  let offset = 0;
  t.mock.method(Math, 'random', () => 0.5);
  t.mock.method(Date, 'now', () => clock() + offset);
  const url = await socketServer(t, socket => {
    sockets.push(socket); attempts.push(clock());
    socket.once('message', () => socket.send(JSON.stringify({ type: 'ready', channel: 'device-control' })));
  });
  const running = watchDeviceUpdates({ url, token: 'test', deviceId: 'remote', signal: stop.signal, wake() {}, onError() {},
    onReady() {
      if (sockets.length === 4) { stop.abort(); return; }
      if (sockets.length === 3) offset += 30_000;
      sockets.at(-1)!.close(1012, 'fixture restart');
    }
  });
  try {
    await running;
    assert.equal(attempts.length, 4);
    assert.ok(attempts[1] - attempts[0] >= 900);
    assert.ok(attempts[2] - attempts[1] >= 1900, 'a brief ready frame must not reset backoff');
    assert.ok(attempts[3] - attempts[2] < 1900, 'stable connections reset backoff');
  } finally { stop.abort(); await running; }
});

test('report acknowledgments with revoked permissions stop reconnection', { timeout: 5000 }, async t => {
  let connections = 0, report: Promise<void> | undefined;
  const url = await socketServer(t, socket => {
    connections++;
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as { type: string; id?: string };
      if (message.type === 'subscribe') socket.send(JSON.stringify({ type: 'ready', channel: 'device-control' }));
      else if (message.type === 'execution-report') socket.send(JSON.stringify({ type: 'report-ack', id: message.id, status: 403, message: 'revoked' }));
    });
  });
  await assert.rejects(watchDeviceUpdates({ url, token: 'test', deviceId: 'remote', signal: new AbortController().signal, wake() {},
    onFeedback(send) { if (send) report = assert.rejects(send({ executionId: 'one', report: { status: 'running' } }), { status: 403 }); },
    onError() { assert.fail('must not retry revoked credentials'); }
  }), { status: 403 });
  await report;
  assert.equal(connections, 1);
});

test('aborting reconnect backoff prevents another WebSocket attempt', { timeout: 5000 }, async t => {
  const stop = new AbortController();
  let connections = 0;
  const url = await socketServer(t, socket => { connections++; socket.terminate(); });
  await watchDeviceUpdates({ url, token: 'test', deviceId: 'remote', signal: stop.signal, wake() {}, onError() { stop.abort(); } });
  assert.equal(connections, 1);
});

test('Git notifications bypass blocked execution and controls and serialize repeated wakes', { timeout: 5000 }, async () => {
  const stop = new AbortController(), releaseWork = deferred(), releaseGit = deferred(), entered = deferred(), repeated = deferred();
  let wake = () => {}, calls = 0;
  const running = runDeviceControl({ signal: stop.signal, pollMs: 60_000,
    work: () => releaseWork.promise, controls: () => releaseWork.promise, async heartbeat() {},
    async git() { if (++calls === 1) { entered.resolve(); await releaseGit.promise; } else repeated.resolve(); },
    onError(error) { throw error; },
    async subscribe(notify, signal) { wake = notify; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }
  });
  try {
    await entered.promise;
    for (let i = 0; i < 20; i++) wake();
    assert.equal(calls, 1);
    releaseGit.resolve(); await repeated.promise;
    assert.equal(calls, 2);
  } finally { releaseWork.resolve(); releaseGit.resolve(); stop.abort(); await running; }
  const finished = calls; await delay(10); assert.equal(calls, finished);
});
