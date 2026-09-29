import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingHistoryMessages } from '../web/src/history/historyTimeline.js';

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

 test('failed submissions without a turn do not appear as duplicate conversation messages', () => {
  assert.deepEqual(pendingHistoryMessages([], [{ ...job, status: 'failed', turnId: null, output: '' }]), []);
});

test('managed conversation display identity does not duplicate turns with a native turn ID', () => {
  const messages = [{ role: 'user', text: 'continue', turnId: 'execution-1' }, { role: 'assistant', text: 'done', turnId: 'execution-1' }];
  assert.deepEqual(pendingHistoryMessages(messages, [{ id: 'execution-1', conversationId: 'managed', turnId: 'native-turn', prompt: 'continue', output: 'done', status: 'completed' }]), []);
});
