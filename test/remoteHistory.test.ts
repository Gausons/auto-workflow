import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRemoteHistory } from '../src/remoteHistory.js';

const image = 'data:image/png;base64,aGVsbG8=';
test('remote history preserves roles, identities and raster previews while bounding text and image payloads', () => {
  const normalized = normalizeRemoteHistory({ offset: 10, total: 14, sourcePartial: false, truncated: false, messages: [
    { role: 'user', text: '查看图片', timestamp: '2026-10-02T00:00:00Z', turnId: 'turn', images: [{ dataUrl: image, alt: '截图' }] },
    { role: 'tool_call', text: '检查', name: 'read_file', callId: 'call', turnId: 'turn' },
    { role: 'tool_result', text: 'x'.repeat(24000), callId: 'call' },
    { role: 'assistant', phase: 'final', text: '**完成**', images: [{ dataUrl: 'data:image/png;base64,' + 'A'.repeat(300000) }, { dataUrl: 'https://example.com/private.png' }, { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }] }
  ] });
  assert.deepEqual(normalized.messages.map(message => message.role), ['user', 'tool_call', 'tool_result', 'assistant']);
  assert.equal(normalized.messages[0].turnId, 'turn');
  assert.equal(normalized.messages[0].text, '查看图片');
  assert.equal(normalized.messages[1].text, '检查');
  assert.equal(normalized.messages[1].callId, 'call');
  assert.equal(normalized.messages[1].name, 'read_file');
  assert.equal(normalized.messages[3].phase, 'final');
  assert.equal(normalized.messages[0].images?.[0].dataUrl, image);
  assert.ok(normalized.messages[3].images?.every(image => !image.dataUrl && image.alt?.includes('未同步')));
  assert.ok(normalized.messages.reduce((sum, message) => sum + (message.text?.length || 0), 0) <= 23000);
  assert.equal(normalized.truncated, true);
  assert.deepEqual(normalizeRemoteHistory(normalized), normalized, 'normalizing again at the server must preserve the connector payload');
});

test('remote history rejects invalid roles, ranges and oversized record arrays', () => {
  const input = { offset: 0, total: 1, sourcePartial: false, truncated: false, messages: [{ role: 'user', text: 'hello' }] };
  for (const change of [{ offset: -1 }, { total: 0 }, { sourcePartial: 'false' }, { messages: [{ role: 'system', text: '不可信' }] }, { messages: [{ role: 'user', text: 123 }] }, { messages: Array(31).fill(input.messages[0]), total: 31 }, { messages: [{ role: 'user', text: '', images: Array(101).fill({}) }] }]) {
    assert.throws(() => normalizeRemoteHistory({ ...input, ...change }), { statusCode: 400 });
  }
});
