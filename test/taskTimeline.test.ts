import test from 'node:test';
import assert from 'node:assert/strict';
import { taskTimeline, taskActivity } from '../public/taskTimeline.js';

test('backfilled history uses original time, executions nest once and missing sources remain visible', () => {
  const task = { id: 't', updatedAt: '2026-09-18T15:00:00Z', sessionIds: ['old', 'new', 'gone'], events: [{ id: 'linked', at: '2026-09-18T15:00:00Z', message: '关联历史' }] };
  const data = { sessions: [{ id: 'old', createdAt: '2026-09-17T08:00:00Z', updatedAt: '2026-09-18T16:00:00Z' }, { id: 'new', createdAt: '2026-09-18T09:00:00Z', deviceId: 'local', agent: 'codex', nativeId: 'thread' }], executions: [{ id: 'job', taskId: 't', deviceId: 'local', agent: 'codex', threadId: 'thread', createdAt: '2026-09-18T09:00:00Z' }, { id: 'pending', taskId: 't', createdAt: '2026-09-18T17:00:00Z' }], handoffs: [] };
  const entries = taskTimeline(task, data);
  assert.ok(entries.findIndex(e => e.id === 'old') < entries.findIndex(e => e.id === 'linked'));
  assert.equal(entries.find(e => e.id === 'new')?.jobs[0].id, 'job');
  assert.ok(!entries.some(e => e.kind === 'execution' && e.id === 'job'));
  assert.equal(entries.find(e => e.id === 'gone')?.value.missing, true);
  assert.equal(taskActivity(task, data), Date.parse('2026-09-18T16:00:00Z'));
});


test('audit transitions do not become timeline nodes while actionable execution and handoff records remain', () => {
  const task = { id: 'task', sessionIds: [], events: ['创建任务', '已提交 Codex 执行（ACP）', '正在创建会话', '正在执行', '本轮执行完成'].map((message, index) => ({ id: `event-${index}`, message })) };
  const data = { sessions: [], executions: ['failed', 'waiting', 'completed'].map(status => ({ id: status, taskId: 'task', status, output: status === 'completed' ? '完成结果' : '' })), handoffs: [{ id: 'handoff', taskId: 'task', status: 'pending' }] };
  const timeline = taskTimeline(task, data);
  assert.equal(timeline.length, 4);
  assert.ok(timeline.every(item => item.kind === 'execution' || item.kind === 'handoff'));
  assert.equal(timeline.find(item => item.id === 'completed')?.value.output, '完成结果');
  assert.equal(task.events.length, 5, 'audit data is preserved without appearing in the reading timeline');
});
