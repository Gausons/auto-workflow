import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, IncomingMessage, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { Socket } from 'node:net';
import { readJson } from '../src/http/body.js';
import { normalizeRemoteHistory, validateRemoteHistory } from '../src/remoteHistory.js';

async function parseChunks(chunks: Buffer[], limit?: number) {
  const request = new IncomingMessage(new Socket());
  const result = readJson(request, limit);
  for (const chunk of chunks) request.push(chunk);
  request.push(null);
  try { return await result; } finally { request.destroy(); }
}

test('JSON request bodies preserve Chinese and emoji split at every UTF-8 byte boundary', async () => {
  const input = { name: '中文😀', nested: { text: '预览🚀完成' } };
  const bytes = Buffer.from(JSON.stringify(input));
  for (let split = 1; split < bytes.length; split++) {
    assert.deepEqual(await parseChunks([bytes.subarray(0, split), bytes.subarray(split)]), input, `split at byte ${split}`);
  }
  assert.deepEqual(await parseChunks([...bytes].map(byte => Buffer.from([byte]))), input);
});

test('a preview at the text limit remains valid after HTTP chunks split a multibyte character', async () => {
  const preview = normalizeRemoteHistory({ offset: 0, total: 1, sourcePartial: false, truncated: false,
    messages: [{ role: 'user', text: '中'.repeat(22998) + '😀' }] });
  const bytes = Buffer.from(JSON.stringify({ remoteHistory: preview }));
  for (const character of ['中', '😀']) {
    for (let offset = 1; offset < Buffer.byteLength(character); offset++) {
      const split = bytes.indexOf(Buffer.from(character)) + offset;
      const decoded = await parseChunks([bytes.subarray(0, split), bytes.subarray(split)]);
      assert.deepEqual(validateRemoteHistory(decoded.remoteHistory), preview);
    }
  }
});

test('a streamed HTTP preview passes strict validation after a split UTF-8 character', { timeout: 10000 }, async t => {
  const preview = normalizeRemoteHistory({ offset: 0, total: 1, sourcePartial: false, truncated: false,
    messages: [{ role: 'user', text: '中'.repeat(22998) + '😀' }] });
  const bytes = Buffer.from(JSON.stringify({ remoteHistory: preview }));
  const split = bytes.indexOf(Buffer.from('中')) + 1;
  let firstChunk!: () => void;
  const received = new Promise<void>(resolve => { firstChunk = resolve; });
  const server = createServer(async (req, res) => {
    const pending = readJson(req);
    req.once('data', firstChunk);
    res.setHeader('Content-Type', 'application/json');
    try {
      const body = await pending;
      res.end(JSON.stringify(validateRemoteHistory(body.remoteHistory)));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid preview' }));
    }
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const request = httpRequest({ hostname: '127.0.0.1', port: address.port, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length } });
  t.after(() => request.destroy());
  const response = once(request, 'response');
  request.write(bytes.subarray(0, split));
  await received;
  request.end(bytes.subarray(split));
  const [incoming] = await response as [IncomingMessage];
  assert.equal(incoming.statusCode, 200);
  assert.deepEqual(await readJson(incoming), preview);
});

test('JSON request bodies enforce byte limits and reject invalid JSON and non-object inputs', async () => {
  const bytes = Buffer.from(JSON.stringify({ text: '中文😀' }));
  assert.deepEqual(await parseChunks([bytes.subarray(0, 5), bytes.subarray(5)], bytes.length), { text: '中文😀' });
  await assert.rejects(parseChunks([bytes.subarray(0, 5), bytes.subarray(5)], bytes.length - 1), { statusCode: 413 });
  for (const text of ['{', '[]', 'null', '"text"', '123', ' ']) {
    await assert.rejects(parseChunks([Buffer.from(text)]), { statusCode: 400 });
  }
  assert.deepEqual(await parseChunks([]), {});
});

test('JSON request body stream errors reject without parsing an incomplete body', async () => {
  const request = new IncomingMessage(new Socket());
  const pending = readJson(request);
  const failure = new Error('request interrupted');
  const rejected = assert.rejects(pending, error => error === failure);
  request.push(Buffer.from('{"text":'));
  request.destroy(failure);
  await rejected;
});
