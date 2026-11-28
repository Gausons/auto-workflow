import type { CollaborationRecord } from '../shared/collaborationTypes.js';
import { isCollaborationRunUnresolved } from '../shared/collaborationTypes.js';
import type { Actor, TaskCenterData } from '../shared/taskTypes.js';
import type { openDatabase } from './database.js';
import { httpError, permissionsFor } from './rbac.js';

type Database = ReturnType<typeof openDatabase>;

export function requireCollaborationTeam(database: Database, tenantId: string) {
  if (!database.isTeamWorkspace(tenantId)) throw httpError(400, '协作任务仅在团队空间开放');
}

export function requireCollaborationActor(database: Database, tenantId: string, actor: Actor) {
  const member = database.getUser(tenantId, actor.id);
  if (!member?.enabled || !permissionsFor(member.role).includes('work.execute')) throw httpError(403, '当前成员没有操作协作任务的权限');
}

export function collaborationInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '请求必须是对象');
  return value as Record<string, unknown>;
}

export function collaborationText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw httpError(400, `请输入 1–${max} 个字符`);
  return value.trim();
}

export function collaborationRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw httpError(400, '请求标识无效');
  return value;
}

export function findCollaboration(data: TaskCenterData, id: string): CollaborationRecord {
  const record = data.collaborations?.find(item => item.id === id);
  if (!record) throw httpError(404, '协作任务不存在');
  return record;
}

export function requireCollaborationRevision(record: CollaborationRecord, value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw httpError(400, '协作任务版本无效');
  if (record.revision !== value) throw httpError(409, '协作任务已更新，请刷新后重试');
}

export function requireFinishedCollaborationRuns(data: TaskCenterData, record: CollaborationRecord, taskId: string) {
  const participants = record.participants.filter(part => taskId === record.parentTaskId || part.taskId === taskId);
  const assigned = new Map(participants.map(part => [part.id, part.taskId]));
  const executions = new Map((data.executions || []).map(job => [job.id, job]));
  for (const run of record.runs) {
    if (!assigned.has(run.participantId)) continue;
    const job = executions.get(run.executionId);
    if (!job || job.taskId !== assigned.get(run.participantId) || isCollaborationRunUnresolved(job)) throw httpError(409, '分工执行尚未结束或结果待核对，请先处理原执行');
  }
}
