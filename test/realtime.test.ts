import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createApp, openDatabase } from '../scripts/testing/database.js';
import { realtimeProtocol } from '../shared/realtime.js';
import type { Execution } from '../shared/taskTypes.js';

type Message = Record<string, unknown>;
async function fixture(t: import('node:test').TestContext) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'realtime-'));
  const app = createApp({ rootDir, environment: { ACP_ENABLED: 'false', CODEX_EXECUTABLE: path.join(rootDir, 'missing-codex'),
    IDE_HISTORY_CODEX_DIR: path.join(rootDir, 'missing-history'), IDE_HISTORY_CLAUDE_DIR: path.join(rootDir, 'missing-claude') } });
  const db = openDatabase(rootDir), clients: WebSocket[] = [];
  let closed = false;
  t.after(async () => { for (const socket of clients) socket.terminate(); if (!closed) await app.close(); db.close(); await rm(rootDir, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`, url = `ws://127.0.0.1:${address.port}/api/realtime`, password = 'realtime-test-password';
  const owner = await db.createUser('default', { username: 'owner', password }, { bootstrap: true });
  const connector = await db.createUser('default', { username: 'connector', password, role: 'operator' }, { actor: owner });
  await db.createUser('default', { username: 'viewer', password, role: 'viewer' }, { actor: owner });
  db.createTenant({ id: 'other', token: 'test-other-token-'.repeat(3) });
  await db.createUser('other', { username: 'other', password }, { bootstrap: true });
  const tokens = { owner: (await db.login('default', 'owner', password)).token, connector: (await db.login('default', 'connector', password)).token,
    viewer: (await db.login('default', 'viewer', password)).token, other: (await db.login('other', 'other', password)).token };
  const execution = (deviceId: string): Execution => ({ id: randomUUID(), taskId: 'task', contextVersion: 1, deviceId, cwd: rootDir, title: '测试执行',
    prompt: 'test', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const job = execution('remote'), otherJob = execution('another-device');
  db.mutateTaskCenter('default', data => {
    data.devices.push(...['remote', 'another-device'].map(id => ({ id, owner: connector.id, name: id, agents: ['codex'], lastSeen: new Date().toISOString(), transport: 'connector' as const })));
    data.executions = [job, otherJob];
  });
  const connect = async (input: unknown) => {
    const socket = new WebSocket(url, realtimeProtocol); clients.push(socket);
    const queue: Message[] = [], waiting: Array<(value: Message) => void> = [];
    socket.on('message', raw => { const message = JSON.parse(raw.toString()) as Message; const deliver = waiting.shift(); if (deliver) deliver(message); else queue.push(message); });
    await once(socket, 'open'); socket.send(JSON.stringify(input));
    const next = async (type: string): Promise<Message> => {
      while (true) {
        const message = queue.shift() || await new Promise<Message>(resolve => waiting.push(resolve));
        if (message.type === type) return message;
      }
    };
    return { socket, queue, next };
  };
  const notify = async () => {
    const response = await fetch(base + '/api/task-center', { method: 'POST', headers: { Authorization: `Bearer ${tokens.owner}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', title: '实时变更' }) });
    assert.equal(response.status, 200); await response.json();
  };
  return { app, db, rootDir, base, url, owner, connector, tokens, job, otherJob, connect, notify, async close() { await app.close(); closed = true; } };
}

test('WebSocket subscriptions enforce authentication, channel permissions, device ownership and tenant boundaries', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  for (const [input, status] of [
    [{ type: 'subscribe', channel: 'task-center', since: 0 }, 401],
    [{ type: 'subscribe', channel: 'task-center', since: 0, token: 'expired' }, 401],
    [{ type: 'subscribe', channel: 'unknown', token: f.tokens.owner }, 404],
    [{ type: 'subscribe', channel: 'task-center', token: f.tokens.owner, since: -1 }, 400],
    [{ type: 'subscribe', channel: 'task-center', token: f.tokens.owner, since: 0, tenantId: 'other' }, 403],
    [{ type: 'subscribe', channel: 'device-control', token: f.tokens.viewer, deviceId: 'remote' }, 403],
    [{ type: 'subscribe', channel: 'device-control', token: f.tokens.owner, deviceId: 'remote' }, 403],
    [{ type: 'subscribe', channel: 'device-control', token: f.tokens.other, deviceId: 'remote' }, 404],
    [{ type: 'subscribe', channel: 'device-control', token: f.tokens.connector, deviceId: '../remote' }, 400]
  ] as const) {
    const client = await f.connect(input), error = await client.next('error'); assert.equal(error.status, status); client.socket.terminate();
  }
  const viewer = await f.connect({ type: 'subscribe', channel: 'task-center', since: 0, token: f.tokens.viewer });
  await viewer.next('ready'); await f.notify();
  assert.equal((await viewer.next('task-center')).version, f.db.readTaskCenter('default').syncVersion);
  viewer.socket.send(JSON.stringify({ type: 'execution-report', id: 'forbidden', input: { executionId: f.job.id, report: { status: 'running' } } }));
  assert.equal((await viewer.next('error')).status, 400);
});

test('WebSocket execution feedback commits before acknowledgment, rejects another device and preserves idempotent reports', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const browser = await f.connect({ type: 'subscribe', channel: 'task-center', since: 1, token: f.tokens.viewer }); await browser.next('ready');
  const device = await f.connect({ type: 'subscribe', channel: 'device-control', deviceId: 'remote', token: f.tokens.connector }); await device.next('ready');
  const payload = { executionId: f.job.id, report: { status: 'running', output: '即时输出中文😀' } };
  device.socket.send(JSON.stringify({ type: 'execution-report', id: 'one', input: payload }));
  const ack = await device.next('report-ack'); assert.equal(ack.id, 'one'); assert.equal(ack.status, 200);
  assert.equal(f.db.readTaskCenter('default').executions[0].output, '即时输出中文😀');
  const event = await browser.next('task-center'); assert.deepEqual((event.changes as { executions: string[] }).executions, [f.job.id]);
  device.socket.send(JSON.stringify({ type: 'execution-report', id: 'duplicate', input: payload }));
  assert.equal((await device.next('report-ack')).status, 200);
  assert.equal(f.db.readTaskCenter('default').executions.length, 2);
  device.socket.send(JSON.stringify({ type: 'execution-report', id: 'wrong-device', input: { ...payload, executionId: f.otherJob.id } }));
  assert.equal((await device.next('report-ack')).status, 403);
  assert.equal(f.db.readTaskCenter('default').executions[1].output, undefined);
  // A subscription's own output does not create a control feedback loop.
  await delay(20); assert.equal(device.queue.some(message => message.type === 'device-control'), false);
  device.socket.send(JSON.stringify({ type: 'execution-report', id: 'invalid-report', input: { executionId: f.job.id, report: { status: 'invalid' } } }));
  assert.equal((await device.next('report-ack')).status, 400);
  // Competing reports on one connection produce an explicit conflict.
  device.socket.send(JSON.stringify({ type: 'execution-report', id: 'first', input: payload }));
  device.socket.send(JSON.stringify({ type: 'execution-report', id: 'competing', input: payload }));
  const results = [await device.next('report-ack'), await device.next('report-ack')];
  assert.ok(results.every(result => [200, 409].includes(Number(result.status))));
  // Managed conversations retain the existing HTTP report budget for long output.
  f.db.mutateTaskCenter('default', data => { data.executions[0].conversationId = 'c'.repeat(64); });
  const output = '中文'.repeat(200_000);
  device.socket.send(JSON.stringify({ type: 'execution-report', id: 'long-output', input: { executionId: f.job.id, report: { status: 'running', output } } }));
  assert.equal((await device.next('report-ack')).status, 200);
  assert.equal(f.db.readTaskCenter('default').executions[0].output?.length, output.length);
});

test('live WebSockets follow revoked permissions and server shutdown releases every connection', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const device = await f.connect({ type: 'subscribe', channel: 'device-control', deviceId: 'remote', token: f.tokens.connector }); await device.next('ready');
  f.db.updateUser('default', f.connector.id, { enabled: false }, f.owner);
  device.socket.send(JSON.stringify({ type: 'pong' }));
  assert.equal((await device.next('error')).status, 401);
  const browser = await f.connect({ type: 'subscribe', channel: 'task-center', since: 0, token: f.tokens.owner }); await browser.next('ready');
  const closed = once(browser.socket, 'close'); await f.close();
  assert.equal((await closed)[0], 1012);
});

test('WebSocket upgrade rejects unknown routes, token query strings and wrong protocols', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  for (const [url, protocol, status] of [[f.url + '?token=secret', realtimeProtocol, 400], [f.url.replace('/api/realtime', '/api/unknown'), realtimeProtocol, 404], [f.url, 'wrong', 400]] as const) {
    const socket = new WebSocket(url, protocol);
    const response = await new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_req, res) => { resolve(res.statusCode || 0); res.resume(); socket.terminate(); });
      socket.once('error', () => {}); socket.once('open', () => reject(new Error('unexpected upgrade')));
    });
    assert.equal(response, status);
  }
});
