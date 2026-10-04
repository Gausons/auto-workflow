import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { verifySnapshot } from '@auto-workflow/context-engine';
import { contextPrompt, freezeContext, readContext, type ContextEntry } from '../src/contextCompiler.js';
import { cleanUserContext } from '../src/agentHistory/adapters.js';
import { contextEntryText } from '../shared/contextContent.js';
import { createContextModelSummarizer, type ModelSummary } from '../src/contextModelSummary.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const image = { type: 'image', mimeType: 'image/png', data: png };
const entry = (role: string, content: unknown): ContextEntry => ({ role, source: 'fixture', text: typeof content === 'string' ? content : JSON.stringify(content) });

test('readable handoff retains failing command exit codes and MCP structured results', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-results-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [
    entry('tool_result', { type: 'commandExecution', command: 'pnpm test', status: 'completed', aggregatedOutput: '', exitCode: 1 }),
    entry('tool_result', { type: 'mcpToolCall', result: { content: [{ type: 'text', text: '见结构化结果' }], structuredContent: { passed: false, failedTests: ['login'] } } }),
    entry('tool_result', { type: 'function_call_output', output: JSON.stringify({ content: [], structuredContent: { check: 'FAILED' }, isError: true }) })
  ];
  const text = entries.map(contextEntryText).join('\n');
  assert.match(text, /退出码：1/);
  assert.match(text, /"passed": false/);
  assert.match(text, /login/);
  assert.match(text, /工具报告失败[\s\S]*FAILED/);
  const compiled = await contextPrompt(freezeContext(entries, ['fixture']), '修复失败', root);
  for (const file of [compiled.markdownPath, compiled.fullMarkdownPath]) {
    const markdown = await readFile(file, 'utf8');
    assert.match(markdown, /退出码：1/);
    assert.match(markdown, /"passed": false/);
    assert.match(markdown, /FAILED/);
  }
});

test('tool images are materialized from Codex, Claude, ACP and native execution results without changing audit evidence', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-parts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = freezeContext([
    entry('tool_result', { type: 'function_call_output', call_id: 'codex', output: JSON.stringify({ content: [image] }) }),
    entry('tool_result', { type: 'tool_result', tool_use_id: 'claude', content: [{ type: 'text', text: '工具截图' }, image] }),
    entry('tool_result', { sessionUpdate: 'tool_call_update', toolCallId: 'acp', content: [{ type: 'content', content: image }] }),
    entry('tool_result', { type: 'mcpToolCall', id: 'native', tool: 'screenshot', result: { content: [image] } })
  ], ['fixture']);
  const compiled = await contextPrompt(snapshot, '检查刚才的截图', root);
  assert.equal(compiled.images.length, 1, 'same original bytes deduplicate across known tool envelopes');
  assert.deepEqual(await readFile(compiled.images[0]!.path), Buffer.from(png, 'base64'));
  const guide = await readFile(compiled.markdownPath, 'utf8');
  const full = await readFile(compiled.fullMarkdownPath, 'utf8');
  assert.doesNotMatch(guide + full + compiled.prompt, /base64,/);
  assert.equal(full.match(/!\[历史图片 image-1\]/g)?.length, 4);
  assert.match(full, /工具截图/);
  assert.ok((await readFile(compiled.exportMarkdownPath, 'utf8')).includes(png));
  assert.deepEqual(verifySnapshot(JSON.parse(await readFile(compiled.evidencePath, 'utf8'))), snapshot);
  assert.deepEqual(await contextPrompt(snapshot, '检查刚才的截图', root), compiled, 'repeated preparation reuses immutable artifacts');
});

test('capture keeps attachment references and Claude tool roles while excluding private thinking and preserving literal JSON', async () => {
  const fileMention = '# Files mentioned by the user:\n\n## report.pdf: /fixture/report.pdf\n\n## My request:\n根据这个 PDF 完成分析';
  const literal = '[{"type":"input_image","image_url":"not a real image"}]';
  const rows = [
    { type: 'user', message: { content: [{ type: 'text', text: fileMention }] } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private secret' }, { type: 'tool_use', name: 'test', id: 'call', input: { command: 'pnpm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', is_error: true, content: 'TEST_FAILURE' }] } },
    { type: 'user', message: { content: literal } }
  ];
  const captured = await readContext({ detail: async () => ({ coverage: { pendingBytes: 0 }, events: rows.map((record, index) => ({ agent: 'claude', kind: 'record', record, sourceLine: index + 1 })) }), record: async () => ({}) }, 'fixture');
  assert.deepEqual(captured.entries.map(value => value.role), ['user', 'tool_call', 'tool_result', 'user']);
  assert.match(contextEntryText(captured.entries[0]!), /report.pdf[\s\S]*普通文件未复制/);
  assert.equal(cleanUserContext(fileMention), '根据这个 PDF 完成分析');
  assert.match(contextEntryText(captured.entries[2]!), /工具报告失败[\s\S]*TEST_FAILURE/);
  assert.equal(contextEntryText(captured.entries[3]!), literal);
  assert.doesNotMatch(JSON.stringify(captured), /private secret|thinking/);
  assert.equal(captured.entries[1]?.callId, 'call');
  const frozen = freezeContext(captured.entries, ['fixture']);
  assert.deepEqual(freezeContext(frozen.entries, ['fixture']).entries, frozen.entries);
});

test('actual Markdown fence costs cannot displace the latest failure from the reading guide', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-fences-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [
    ...Array.from({ length: 40 }, () => entry('assistant', 'x'.repeat(90))),
    entry('tool_result', { type: 'function_call_output', output: '`'.repeat(400) + 'LATEST_FAILURE' })
  ];
  const compiled = await contextPrompt(freezeContext(entries, ['fixture']), '继续', root, 3000);
  const guide = await readFile(compiled.markdownPath, 'utf8');
  assert.ok(guide.length <= 3000);
  assert.match(guide, /LATEST_FAILURE/);
  const manyFences = entry('assistant', '`x'.repeat(150000));
  const large = await contextPrompt(freezeContext([manyFences], ['fixture']), '继续', root);
  assert.ok((await readFile(large.fullMarkdownPath, 'utf8')).includes(manyFences.text));
});

test('bounded first reading keeps latest evidence and full history stays independently readable', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-guide-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [entry('user', '原始目标：修复兼容性'), ...Array.from({ length: 80 }, (_, index) => entry('tool_result', { type: 'function_call_output', output: `OLD_${index}_` + 'x'.repeat(3000) })), entry('user', '最新修正：不要更改公开接口'), entry('tool_result', { type: 'function_call_output', output: 'LATEST_TEST_FAILURE' }), entry('assistant', '仍需修复失败用例')];
  const compiled = await contextPrompt(freezeContext(entries, ['fixture']), '继续', root, 3000);
  const guide = await readFile(compiled.markdownPath, 'utf8');
  const full = await readFile(compiled.fullMarkdownPath, 'utf8');
  assert.ok(guide.length <= 3000);
  assert.equal(compiled.compacted, true);
  assert.match(guide, /LATEST_TEST_FAILURE/);
  assert.match(guide, /最新修正/);
  assert.match(guide, /原始目标/);
  assert.ok(full.includes('OLD_0_' + 'x'.repeat(3000)));
  assert.ok(full.includes('OLD_79_' + 'x'.repeat(3000)));
  assert.deepEqual(verifySnapshot(JSON.parse(await readFile(compiled.evidencePath, 'utf8'))).entries, entries);
  await assert.rejects(contextPrompt(freezeContext(entries, ['fixture']), '继续', root, 3000, false), { statusCode: 422 });
});

test('model summary receives failing tool evidence and newest corrections before older records consume its budget', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-model-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [...Array.from({ length: 101 }, (_, index) => entry('user', `history-${index} ` + 'x'.repeat(1000))),
    entry('tool_call', { type: 'function_call', name: 'test', arguments: 'pnpm test' }),
    entry('tool_result', { type: 'function_call_output', output: 'LATEST_TEST_FAILURE' }), entry('assistant', '测试已通过')];
  const summary: ModelSummary = { goal: [], constraints: [], decisions: [], completed: [], next: [], uncertain: [{ text: '工具失败与助手说法冲突', refs: [103, 104] }] };
  const summarize = createContextModelSummarizer({ apiKey: 'fixture', baseUrl: 'https://example.invalid', model: 'fixture', timeoutMs: 1000, fetchImpl: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { input: Array<{ content: string }> };
    const content = JSON.parse(request.input[1]!.content) as { records: Array<{ index: number; text: string }> };
    assert.ok(content.records.some(value => value.text.includes('LATEST_TEST_FAILURE')));
    assert.ok(content.records.some(value => value.text.includes('pnpm test')));
    assert.ok(content.records.some(value => value.index === 101));
    assert.ok(!content.records.some(value => value.index === 1), 'older records yield budget to recent turns');
    return Response.json({ output_text: JSON.stringify(summary) });
  } });
  const result = await summarize(freezeContext(entries, ['fixture']), entries, root);
  assert.equal(result.status, 'complete');
  if (result.status === 'complete') { assert.ok(result.coverage); assert.ok(result.coverage.includedRecords < entries.length); assert.ok(result.coverage.recordRefs.includes(104)); }
});
