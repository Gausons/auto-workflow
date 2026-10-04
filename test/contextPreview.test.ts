import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedContextPreview } from '../src/contextPreview.js';
import type { ContextEntry } from '../src/contextCompiler.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1kAAAAASUVORK5CYII=';
const entry = (role: string, content: unknown, extra: Partial<ContextEntry> = {}): ContextEntry => ({ role, source: 'source-session', line: 12, text: typeof content === 'string' ? content : JSON.stringify(content), ...extra });

test('context preview projects multimodal content, tool metadata and evidence without mutating source', () => {
  const entries = [
    entry('user', [{ type: 'input_text', text: '请看截图 <script>bad()</script>' }, { type: 'input_image', image_url: `data:image/png;base64,${png}` }]),
    entry('tool_call', { type: 'function_call', name: 'read_file', call_id: 'call-1', arguments: '{"path":"README.md"}' }),
    entry('tool_result', { type: 'function_call_output', call_id: 'call-1', output: { content: [{ type: 'text', text: '测试失败' }, { type: 'image', mimeType: 'image/png', data: png }], isError: true } }),
    entry('assistant', [{ type: 'output_text', text: '**结论需核对**' }])
  ];
  const saved = JSON.stringify(entries);
  const result = normalizedContextPreview(entries);
  assert.equal(result.messages[0]?.text, '请看截图 <script>bad()</script>');
  assert.equal(result.messages[0]?.images?.[0]?.dataUrl, `data:image/png;base64,${png}`);
  assert.equal(result.messages[1]?.name, 'read_file');
  assert.equal(result.messages[1]?.callId, 'call-1');
  assert.match(result.messages[2]?.text || '', /工具报告失败[\s\S]*测试失败/);
  assert.equal(result.messages[2]?.images?.length, 1);
  assert.equal(result.messages[3]?.text, '**结论需核对**');
  assert.deepEqual(result.stats, { users: 1, assistants: 1, tools: 2, references: 0, images: 2, unavailableImages: 0, truncatedMessages: 0, unsupportedBlocks: 0 });
  assert.deepEqual(result.excerpts.map(item => item.record), [1, 4]);
  assert.equal(result.messages[0]?.source, 'source-session');
  assert.equal(result.messages[0]?.line, 12);
  assert.equal(JSON.stringify(entries), saved);
});

test('context preview preserves literal JSON and quoted protocol examples without decoding text blocks again', () => {
  const literal = '{"text":"do not discard the key", "content": [1, 2]}';
  const example = '[{"type":"input_text","text":"example"}]';
  const result = normalizedContextPreview([entry('user', literal), entry('assistant', [{ type: 'text', text: example }])]);
  assert.equal(result.messages[0]?.text, literal);
  assert.equal(result.messages[1]?.text, example);
});

test('context preview rejects external, mismatched, oversized and executable images with explicit placeholders', () => {
  const result = normalizedContextPreview([entry('user', [
    { type: 'input_image', image_url: 'https://attacker.invalid/tracker.png' },
    { type: 'input_image', image_url: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    { type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}` },
    { type: 'image_reference', unavailable: true, reason: '原图丢失' }
  ])]);
  assert.equal(result.stats.images, 5);
  assert.equal(result.stats.unavailableImages, 5);
  assert.ok(result.messages[0]?.images?.every(image => !image.dataUrl && image.alt?.startsWith('图片无法预览')));
  assert.doesNotMatch(JSON.stringify(result), /attacker\.invalid|PHN2Zz4=|aGVsbG8=/);
});

test('context preview bounds long and unrecognized payloads and reports attachment references', () => {
  const result = normalizedContextPreview([
    entry('user', `未识别图片 data:image/png;base64,${png}`),
    entry('tool_result', 'x'.repeat(20000)),
    entry('user', [{ type: 'attachment_reference', name: '说明.pdf', path: '/tmp/说明.pdf' }])
  ]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(png.replace(/[+]/g, '\\+')));
  assert.match(result.messages[0]?.text || '', /图片编码已隐藏/);
  assert.equal(result.messages[1]?.truncated, true);
  assert.ok((result.messages[1]?.text?.length || 0) < 12100);
  assert.equal(result.stats.truncatedMessages, 1);
  assert.equal(result.stats.unsupportedBlocks, 1);
  assert.match(result.messages[2]?.text || '', /说明.pdf[\s\S]*文件未复制/);
});

test('context preview paginates records while retaining stable origin excerpts and global counts', () => {
  const entries = Array.from({ length: 105 }, (_, index) => entry(index % 2 ? 'assistant' : 'user', `消息 ${index + 1}`));
  const first = normalizedContextPreview(entries);
  const next = normalizedContextPreview(entries, first.nextOffset!);
  assert.equal(first.messages.length, 100);
  assert.equal(first.nextOffset, 100);
  assert.equal(next.messages[0]?.record, 101);
  assert.equal(next.messages.length, 5);
  assert.equal(next.nextOffset, null);
  assert.deepEqual(first.stats, next.stats);
  assert.deepEqual(first.excerpts.map(item => item.record), [1, 103, 104, 105]);
  assert.deepEqual(first.excerpts, next.excerpts);
  assert.equal(normalizedContextPreview(entries, 106).nextOffset, null);
});
