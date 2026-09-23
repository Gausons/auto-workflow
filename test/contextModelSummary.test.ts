import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freezeContext, contextPrompt } from '../src/contextCompiler.js';
import { createContextModelSummarizer, type ModelSummary } from '../src/contextModelSummary.js';

test('model summary cites source records, excludes image data, and reuses the saved result', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-summary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = freezeContext([
    { role: 'user', source: 'source', text: JSON.stringify([{ type: 'input_text', text: '保持接口兼容' }, { type: 'image_reference', id: 'image-1', path: '/untrusted', sha256: 'bad' }]) },
    { role: 'assistant', source: 'source', text: '下一步补测试' }
  ], ['source']);
  const summary: ModelSummary = { goal: [{ text: '保持接口兼容', refs: [1] }], constraints: [], decisions: [], completed: [], next: [{ text: '补测试', refs: [2] }], uncertain: [] };
  let calls = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    assert.equal(request.text.format.type, 'json_schema');
    assert.doesNotMatch(JSON.stringify(request), /base64|\/untrusted/);
    return Response.json({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(summary) }] }] });
  }) as typeof fetch;
  const summarize = createContextModelSummarizer({ apiKey: 'test-key', baseUrl: 'https://example.invalid/v1', model: 'test-model', timeoutMs: 1000, fetchImpl });
  const first = await contextPrompt(snapshot, '继续', root, 120000, true, summarize);
  assert.match(first.prompt, /模型整理/);
  assert.match(first.prompt, /保持接口兼容（记录 1）/);
  assert.equal((await summarize(snapshot, snapshot.entries, root)).status, 'complete');
  assert.equal(calls, 1);
});

test('unavailable or invalid model summary is labeled and the handoff remains usable', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-summary-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = freezeContext([{ role: 'user', source: 'source', text: '继续任务' }], ['source']);
  const unavailable = await contextPrompt(snapshot, '继续', root);
  assert.match(unavailable.prompt, /未配置模型摘要服务/);
  const invalid = createContextModelSummarizer({
    apiKey: 'test-key', baseUrl: 'https://example.invalid/v1', model: 'test-model', timeoutMs: 1000,
    fetchImpl: (async () => Response.json({ output_text: JSON.stringify({ goal: [{ text: '凭空结论', refs: [99] }], constraints: [], decisions: [], completed: [], next: [], uncertain: [] }) })) as typeof fetch
  });
  const fallback = await contextPrompt(snapshot, '继续', root, 120000, true, invalid);
  assert.notEqual(fallback.markdownPath, unavailable.markdownPath);
  assert.match(fallback.prompt, /模型整理失败，已使用原文摘取/);
  assert.match(fallback.prompt, /继续任务/);
});
