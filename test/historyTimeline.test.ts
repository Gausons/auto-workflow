import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingHistoryMessages } from '../public/historyTimeline.js';
import { createHistoryComposer } from '../public/historyComposer.js';

const job = { id: 'job-1', turnId: 'turn-1', prompt: '查金价', output: '金价回复', status: 'completed', createdAt: '2026-09-20T01:00:00Z' };
const saved = [{ role: 'user', text: job.prompt, turnId: job.turnId }, { role: 'assistant', text: job.output, turnId: job.turnId }];

test('persisted turns replace live messages, including partial persistence', () => {
  assert.deepEqual(pendingHistoryMessages(saved, [job]), []);
  assert.deepEqual(pendingHistoryMessages(saved.slice(0, 1), [job]), [{ role: 'assistant', text: job.output }]);
  assert.equal(pendingHistoryMessages([], [job]).length, 2);
});

test('identical prompts in different turns remain distinct', () => {
  const second = { ...job, id: 'job-2', turnId: 'turn-2' };
  assert.equal(pendingHistoryMessages(saved, [job, second]).length, 2);
  assert.equal(pendingHistoryMessages([], [job, second]).length, 4);
  assert.equal(pendingHistoryMessages([...saved, ...saved.map(m => ({ ...m, turnId: second.turnId }))], [job, second]).length, 0);
});

test('legacy records use submission time instead of collapsing repeated text', () => {
  const legacy = saved.map(m => ({ ...m, turnId: undefined, timestamp: '2026-09-19T01:00:00Z' }));
  assert.equal(pendingHistoryMessages(legacy, [job]).length, 2);
  assert.equal(pendingHistoryMessages(legacy.map(m => ({ ...m, timestamp: job.createdAt })), [job]).length, 0);
});

test('composer keeps every pending turn and removes persisted copies without remounting the input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const nodes = new Map<string, any>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', innerHTML: '', textContent: '', disabled: false });
    return nodes.get(selector);
  };
  const host: any = { innerHTML: '', querySelector: node };
  const output: any = { innerHTML: '', closest: () => null };
  const second = { ...job, id: 'job-2', turnId: 'turn-2', prompt: '第二轮', output: '第二轮回复' };
  let records: any[] = [], executions = [job];
  const composer = createHistoryComposer({ api: async () => ({ execution: executions.at(-1), executions }), canEdit: () => true,
    syncHistory: async () => records, refresh: () => {} });
  t.after(() => composer.unmount());
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  composer.mount(host, { id: 'history', agent: 'codex', sessionId: 'session' }, output);
  await flush();
  assert.match(output.innerHTML, /金价回复/);
  const form = host.innerHTML;
  node('textarea').value = '保留草稿';
  executions = [job, second];
  t.mock.timers.tick(2500); await flush();
  assert.match(output.innerHTML, /金价回复/);
  assert.match(output.innerHTML, /第二轮回复/);
  records = saved;
  t.mock.timers.tick(2500); await flush();
  assert.doesNotMatch(output.innerHTML, /金价回复/);
  assert.match(output.innerHTML, /第二轮回复/);
  assert.equal(node('textarea').value, '保留草稿');
  assert.equal(host.innerHTML, form);
});

 test('failed submissions without a turn do not appear as duplicate conversation messages', () => {
  assert.deepEqual(pendingHistoryMessages([], [{ ...job, status: 'failed', turnId: null, output: '' }]), []);
});
