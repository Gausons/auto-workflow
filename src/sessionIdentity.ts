import type { Execution, Session, TaskCenterData } from '../shared/taskTypes.js';
import { codexProviderError } from './agentExecutionError.js';

export const executionSession = (session: Session) => ['codexExecution', 'agentExecution'].includes(session.source || '');
export const nativeSessionKey = (session: Pick<Session, 'deviceId' | 'agent' | 'nativeId'>) => JSON.stringify([session.deviceId, session.agent, session.nativeId || '']);
export const sameNativeSession = (left: Session, right: Session) => Boolean(left.nativeId && right.nativeId && nativeSessionKey(left) === nativeSessionKey(right));

export function executionResult(job: Execution): Execution {
  const error = job.agent === 'codex' && job.protocol === 'acp' && job.status === 'completed' ? codexProviderError(job.output) : undefined;
  return error ? { ...job, status: 'failed', message: error } : job;
}

export function sessionExecutionResult(session: Session, data: TaskCenterData): Session {
  const job = (data.executions || []).filter(item => session.source === 'conversation' ? item.conversationId === session.id : !item.conversationId && item.deviceId === session.deviceId && (item.agent || 'codex') === session.agent && Boolean(session.nativeId) && (item.sessionId || item.threadId) === session.nativeId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!job) return session;
  const result = executionResult(job);
  // A later native turn can supersede a managed execution. Do not overwrite it.
  if (result.updatedAt < session.updatedAt && !executionSession(session) && session.status && session.status !== 'completed') return session;
  return { ...session, status: result.status, ...(result.status === 'failed' ? { executionError: result.message || 'Agent 本轮执行失败' } : {}) };
}
