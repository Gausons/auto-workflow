import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';
import { connectorDirectory, listConnectors, openConnectorControl, stopConnector } from '../packages/device-agent/src/control.js';

test('local connector control isolates connections, requires its own secret and holds an OS lease through shutdown', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'connector-control-'));
  const opened: Array<Awaited<ReturnType<typeof openConnectorControl>>> = [];
  t.after(async () => { for (const control of opened) await control.close(); await rm(root, { recursive: true, force: true }); });
  let stopped = 0;
  const identity = { origin: 'https://work.example.com', tenantId: 'one', userId: 'owner' };
  const first = await openConnectorControl({ root, stateDir: path.join(root, 'one'), identity, stop() { stopped++; } }); opened.push(first);
  await first.ready();
  const record = JSON.parse(await readFile(path.join(connectorDirectory(root), `${first.info().id}.json`), 'utf8')) as { secret: string };
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: first.info().port });
    socket.once('error', reject); socket.once('close', () => resolve());
    socket.once('connect', () => socket.write(JSON.stringify({ protocol: 'agent-workbench-connector', id: first.info().id, secret: 'wrong', action: 'stop' }) + '\n'));
  });
  assert.equal(stopped, 0);
  const listed = await listConnectors(root);
  assert.equal(listed[0]!.status, 'running');
  assert.ok(!JSON.stringify(listed).includes(record.secret));
  await assert.rejects(openConnectorControl({ root, stateDir: path.join(root, 'one'), identity, stop() {} }), /已在运行/);
  await assert.rejects(stopConnector(root, '../outside'), /连接标识无效/);
  const second = await openConnectorControl({ root, stateDir: path.join(root, 'two'), identity: { ...identity, tenantId: 'two' }, stop() {} }); opened.push(second);
  await second.ready();
  assert.equal((await listConnectors(root)).filter(item => item.status === 'running').length, 2);
  await first.close(); opened.splice(opened.indexOf(first), 1);
  assert.equal(await stopConnector(root, first.info().id), false);
  assert.equal((await listConnectors(root)).find(item => item.id === second.info().id)?.status, 'running');
  const replacement = await openConnectorControl({ root, stateDir: path.join(root, 'one'), identity, stop() {} }); opened.push(replacement);
  assert.equal(replacement.info().id, first.info().id);
  const next = await readFile(path.join(connectorDirectory(root), `${first.info().id}.json`), 'utf8');
  assert.ok(!next.includes(record.secret), 'restart replaces the local control secret');
});
