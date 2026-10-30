import test from 'node:test';
import assert from 'node:assert/strict';
import { codexProviderError } from '../src/agentExecutionError.js';
import { executionResult, sameNativeSession } from '../src/sessionIdentity.js';
import { recordExecution } from '../src/codexExecution.js';
import type { Execution, Session, TaskCenterData } from '../shared/taskTypes.js';

const failure = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', code: 'model_not_found', message: 'Model is not supported' } });
const job: Execution = { id: 'job', taskId: 'task', deviceId: 'remote', agent: 'codex', protocol: 'acp', sessionId: 'native', title: '你好', prompt: '你好', cwd: '/repo', status: 'completed', output: failure, contextVersion: 1, createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:01:00Z' };

test('recognizes only whole provider failures, preserving quoted examples and ordinary replies', () => {
  assert.equal(codexProviderError(failure), 'Model is not supported');
  for (const output of [`例子：${failure}`, `\`\`\`json\n${failure}\n\`\`\``, `已修复\n${failure}`, JSON.stringify({ type: 'error', status: 200, error: { type: 'example', message: 'error' } }), 'model_not_found']) assert.equal(codexProviderError(output), undefined);
  assert.equal(executionResult(job).status, 'failed');
  assert.equal(job.status, 'completed', 'historical projection never rewrites source data');
  assert.equal(executionResult({ ...job, status: 'unknown' }).status, 'unknown', 'uncertain work remains uncertain');
});

test('execution sessions retain existing IDs and isolate identical native IDs by device and Agent', () => {
  const data: TaskCenterData = { tasks: [{ id: 'task', title: '你好', status: 'running', revision: 1, contextVersion: 1, sessionIds: [], events: [], createdAt: job.createdAt, updatedAt: job.updatedAt }], devices: [], sessions: [], handoffs: [], executions: [{ ...job, status: 'running' }] };
  const legacy: Session = { id: 'legacy', source: 'agentExecution', nativeId: 'native', deviceId: 'remote', agent: 'codex', title: '你好', cwd: '/repo', updatedAt: job.updatedAt };
  data.sessions.push(legacy); data.tasks[0].sessionIds.push(legacy.id);
  recordExecution(data, job);
  assert.equal(data.sessions.length, 1); assert.equal(data.sessions[0].id, 'legacy');
  assert.equal(data.tasks[0].status, 'error'); assert.equal(data.executions[0].status, 'failed');
  for (const patch of [{ deviceId: 'other-device' }, { agent: 'claude' }]) {
    const next = { ...job, ...patch, id: JSON.stringify(patch), status: 'running' as const };
    data.executions.push(next); recordExecution(data, next);
  }
  assert.equal(data.sessions.length, 3); assert.equal(new Set(data.sessions.map(s => s.id)).size, 3);
  assert.equal(sameNativeSession(data.sessions[0], data.sessions[1]), false);
  assert.equal(sameNativeSession(data.sessions[0], data.sessions[2]), false);
});
