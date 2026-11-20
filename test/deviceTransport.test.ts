import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { WebSocket } from 'undici';
import { createMacTrustDispatcher, DeviceCertificateError } from '../src/deviceTransport.js';

test('the macOS trust path gates HTTPS requests and WebSocket upgrades on peer and hostname validation', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-test-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = path.join(directory, 'key.pem');
  const certFile = path.join(directory, 'cert.pem');
  const config = path.join(directory, 'cert.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\n[ext]\nsubjectAltName=IP:127.0.0.1\n');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=workbench-test.invalid', '-config', config, '-keyout', keyFile, '-out', certFile]);
  const [key, cert] = await Promise.all([readFile(keyFile), readFile(certFile)]);
  const leaf = new X509Certificate(cert).raw;

  let requests = 0, upgrades = 0;
  const server = createServer({ key, cert }, (request, response) => {
    requests++;
    request.resume();
    response.end('connected');
  });
  const realtime = new WebSocketServer({ server });
  realtime.on('connection', socket => { upgrades++; socket.send('connected'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of realtime.clients) socket.terminate();
    realtime.close();
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `https://127.0.0.1:${address.port}`;
  const post = (dispatcher: ReturnType<typeof createMacTrustDispatcher>) => {
    const options = { method: 'POST', body: 'fixture-token', redirect: 'error' as const, dispatcher, signal: AbortSignal.timeout(5000) };
    return fetch(url, options);
  };
  const assertPeer = (hostname: string, chain: Buffer[]) => {
    assert.equal(hostname, '127.0.0.1');
    assert.deepEqual(chain, [leaf]);
  };
  let rejectedPeers = 0;
  const denied = createMacTrustDispatcher(async (hostname, chain) => {
    assertPeer(hostname, chain);
    rejectedPeers++;
    throw new Error('not in the trusted store');
  });
  t.after(() => denied.destroy());
  const rejected = (error: unknown) => error instanceof Error && error.cause instanceof DeviceCertificateError;
  await assert.rejects(post(denied), rejected);
  assert.equal(rejectedPeers, 1);
  assert.equal(requests, 0);

  let verified = 0;
  const verify = async (hostname: string, chain: Buffer[]) => { assertPeer(hostname, chain); verified++; };
  const accepted = createMacTrustDispatcher(verify);
  t.after(() => accepted.destroy());
  assert.equal(await (await post(accepted)).text(), 'connected');
  assert.equal(requests, 1);
  assert.equal(verified, 1);
  const wrongHost = { dispatcher: accepted, signal: AbortSignal.timeout(5000) };
  await assert.rejects(fetch(`https://localhost:${address.port}`, wrongHost), rejected);
  assert.equal(verified, 1);
  assert.equal(requests, 1);

  const websocketDispatcher = createMacTrustDispatcher(verify);
  t.after(() => websocketDispatcher.destroy());
  const options = { dispatcher: websocketDispatcher, protocols: 'workbench-test' };
  const socket = new WebSocket(`wss://127.0.0.1:${address.port}`, options);
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('TLS WebSocket timed out')), 5000);
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('TLS WebSocket failed')); }, { once: true });
      socket.addEventListener('message', event => {
        clearTimeout(timeout);
        if (event.data === 'connected') resolve();
        else reject(new Error('Unexpected WebSocket message'));
      }, { once: true });
    });
    assert.equal(upgrades, 1);
    assert.equal(verified, 2);
  } finally { socket.close(); }
});
