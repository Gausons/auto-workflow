import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contextRequirements, selectHandoffRecords } from '../shared/contextSelection.js';
import { contextPrompt, freezeContext, type ContextEntry } from '../src/contextCompiler.js';

const entry = (role: string, text: string, turnId = 'turn'): ContextEntry => ({ role, text, turnId, source: 'fixture' });

test('long histories retain middle requirements in both first read and summary evidence', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = Array.from({ length: 180 }, (_, index) => [
    entry('user', index === 50 ? '保持返回格式兼容，禁止新增生产依赖。' : `处理第 ${index} 项。`, `turn-${index}`),
    entry('assistant', '过程说明'.repeat(160), `turn-${index}`)
  ]).flat();
  const snapshot = freezeContext(entries, ['fixture']);
  const compiled = await contextPrompt(snapshot, '继续', root);
  const guide = await readFile(compiled.markdownPath, 'utf8');
  assert.match(compiled.prompt, /保持返回格式兼容/);
  assert.match(guide, /禁止新增生产依赖/);
  assert.ok(selectHandoffRecords(entries, 80000).some(record => record.index === 101));
  assert.ok(guide.length + compiled.brief.length <= 24000);
  assert.deepEqual(JSON.parse(await readFile(compiled.evidencePath, 'utf8')), snapshot);
});

test('current message retrieves an older file and keeps paired tool input and output', () => {
  const entries = [entry('user', '检查登录'),
    entry('tool_call', JSON.stringify({ type: 'function_call', call_id: 'one', name: 'test', arguments: 'pnpm test auth.test.ts' })),
    entry('tool_result', JSON.stringify({ type: 'function_call_output', call_id: 'one', output: '登录场景缺少并发处理' })),
    ...Array.from({ length: 100 }, (_, index) => entry('assistant', `新的无关话题 ${index} ${'x'.repeat(600)}`, `new-${index}`))];
  const selected = selectHandoffRecords(entries, 2500, 500, '回到 auth.test.ts');
  assert.ok(selected.some(record => record.index === 2 && record.reasons.includes('本轮关联')));
  assert.ok(selected.some(record => record.index === 3));
  assert.ok(selected.reduce((sum, record) => sum + record.text.length + 100, 0) <= 2500);
  assert.ok(!selectHandoffRecords(entries, 2500, 500, '处理新的话题').some(record => record.index === 2));
});

test('requirement index preserves corrections, repeated instructions, and the middle of long messages', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-requirements-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [entry('user', '采用方案 A。'), entry('user', '改为方案 B，不再采用 A。', 'second'),
    entry('user', `${'前言'.repeat(2000)}必须保留接口兼容${'附录'.repeat(2000)}`, 'third'), entry('user', '采用方案 A。', 'fourth')];
  assert.equal(contextRequirements(entries).length, 4);
  const compiled = await contextPrompt(freezeContext(entries, ['fixture']), '继续方案 B', root);
  assert.match(compiled.brief, /必须保留接口兼容/);
  assert.match(compiled.brief, /候选/);
  const guide = await readFile(compiled.markdownPath, 'utf8');
  const index = /\[要求索引\]\(([^)]+)\)/.exec(guide)?.[1];
  assert.ok(index);
  const content = await readFile(path.join(root, index), 'utf8');
  assert.match(content, /记录 1/); assert.match(content, /记录 4/);
  assert.ok(content.includes(entries[2]!.text));
});

test('tool identity is scoped by source and turn and progress does not replace original input', () => {
  const call = (turn: string, sessionUpdate: string, text: string) => entry('tool_result', JSON.stringify({ sessionUpdate, toolCallId: 'same', rawInput: text, status: 'completed' }), turn);
  const entries = [call('old', 'tool_call', 'unrelated'), call('new', 'tool_call', 'target.test.ts'),
    ...Array.from({ length: 30 }, () => call('new', 'tool_call_update', 'progress')),
    call('new', 'tool_call_update', 'FAIL target.test.ts')];
  const selected = selectHandoffRecords(entries, 1200, 350, 'target.test.ts');
  assert.ok(selected.some(record => record.index === 2));
  assert.ok(selected.some(record => record.index === entries.length));
  assert.ok(selected.filter(record => record.index > 2 && record.index < entries.length).length === 0);
});

test('a failing tool remains distinct from the assistant claiming success and unknown execution', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = freezeContext([entry('user', '继续补测试'), entry('tool_result', JSON.stringify({ type: 'commandExecution', command: 'pnpm test', exitCode: 1, aggregatedOutput: 'FAIL concurrency' })),
    entry('assistant', '测试已经通过'), { ...entry('reference', '执行结果待核对，不得自动重发'), source: 'execution:fixture' }], ['fixture']);
  const compiled = await contextPrompt(snapshot, '继续', root);
  assert.match(compiled.brief, /退出码：1/);
  assert.match(compiled.brief, /未经验证/);
  assert.match(compiled.brief, /执行结果待核对/);
  assert.match(compiled.prompt, /不继承原会话工具授权/);
});
