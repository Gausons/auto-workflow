import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceReconnectBackoff, retryDeviceConnection } from '../src/deviceReconnect.js';

test('device reconnect backoff grows to thirty seconds, adds jitter and resets after recovery', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const backoff = createDeviceReconnectBackoff();
  assert.deepEqual(Array.from({ length: 8 }, () => backoff.next()), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  backoff.reset(); assert.equal(backoff.next(), 1000);
  t.mock.method(Math, 'random', () => 0);
  backoff.reset(); assert.equal(backoff.next(), 800);
  t.mock.method(Math, 'random', () => 1);
  backoff.reset(); assert.equal(backoff.next(), 1200);
  for (let i = 0; i < 10; i++) assert.ok(backoff.next() <= 30000);
});

test('safe connection retries recover from network, timeout and proxy failures with backoff', { timeout: 15000 }, async t => {
  t.mock.method(Math, 'random', () => 0.5);
  const failures = [new TypeError('fetch failed'), new DOMException('timeout', 'TimeoutError'), Object.assign(new Error('proxy'), { status: 503 })];
  const waits: number[] = [];
  let attempts = 0;
  const running = retryDeviceConnection(async () => {
    const failure = failures[attempts++];
    if (failure) throw failure;
    return 'connected';
  }, { signal: new AbortController().signal, onRetry(_error, wait) { waits.push(wait); } });
  assert.equal(await running, 'connected');
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.equal(attempts, 4);
});

test('invalid identity, authorization and permanent HTTP failures do not retry', async () => {
  for (const error of [new Error('invalid identity'), ...[400, 401, 403, 404, 409].map(status => Object.assign(new Error('rejected'), { status }))]) {
    let attempts = 0;
    await assert.rejects(retryDeviceConnection(async () => { attempts++; throw error; }, {
      signal: new AbortController().signal, onRetry() { assert.fail('must not retry'); }
    }), error);
    assert.equal(attempts, 1);
  }
});

test('stopping during reconnect backoff cancels the pending attempt immediately', async () => {
  const stop = new AbortController();
  let attempts = 0;
  await assert.rejects(retryDeviceConnection(async () => { attempts++; throw new TypeError('offline'); }, {
    signal: stop.signal, onRetry() { stop.abort(); }
  }), { name: 'AbortError' });
  assert.equal(attempts, 1);
});
