import type { Task, TaskCenterData } from './taskTypes.js';

export const taskCenterCollections = ['tasks', 'devices', 'sessions', 'handoffs', 'executions', 'directoryRequests', 'gitRequests'] as const;
export type TaskCenterCollection = typeof taskCenterCollections[number];
export type TaskCenterChangeIds = Partial<Record<TaskCenterCollection, string[]>>;
export type TaskCenterChanges = { [K in TaskCenterCollection]?: { upsert: NonNullable<TaskCenterData[K]>; removed: string[] } };
export type TaskCenterDelta = { fromVersion: number; version: number } & (
  { reset: true; snapshot: TaskCenterData } |
  { reset: false; changes: TaskCenterChanges; changedIds: TaskCenterChangeIds; replaceLocalSessions: true }
);
export interface TaskCenterUpdate { version: number; changes?: TaskCenterChangeIds; reset?: boolean }

const statuses = ['waiting', 'error', 'running', 'ready', 'review', 'completed'];
export const sortTasks = (tasks: Task[]) => tasks.sort((a, b) => statuses.indexOf(a.status) - statuses.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt));

function merge<T extends { id: string }>(current: T[], patch?: { upsert: T[]; removed: string[] }): T[] {
  if (!patch) return current;
  const byId = new Map(current.map(item => [item.id, item]));
  for (const id of patch.removed) byId.delete(id);
  for (const item of patch.upsert) byId.set(item.id, item);
  return [...byId.values()];
}

/** Only apply a patch to the exact base it was fetched against. */
export function applyTaskCenterDelta(current: TaskCenterData, delta: TaskCenterDelta): TaskCenterData {
  if ((current.syncVersion || 0) !== delta.fromVersion) throw new Error('同步版本不匹配，请重新读取变更');
  if (delta.reset) return delta.snapshot;
  const changes = delta.changes;
  return {
    ...current, syncVersion: delta.version,
    tasks: sortTasks(merge(current.tasks, changes.tasks)),
    devices: merge(current.devices, changes.devices).map(device => ({ ...device, online: device.id === 'local' || Date.now() - Date.parse(device.lastSeen) < 90000 })),
    // Local file history is discovered on reads rather than persisted in the journal.
    sessions: merge(current.sessions.filter(session => session.deviceId !== 'local'), changes.sessions),
    handoffs: merge(current.handoffs, changes.handoffs),
    executions: merge(current.executions || [], changes.executions),
    directoryRequests: merge(current.directoryRequests || [], changes.directoryRequests),
    gitRequests: merge(current.gitRequests || [], changes.gitRequests)
  };
}

export function taskCenterDelta(snapshot: TaskCenterData, fromVersion: number, changedIds: TaskCenterChangeIds, reset: boolean): TaskCenterDelta {
  const version = snapshot.syncVersion || 0;
  if (reset) return { fromVersion, version, reset: true, snapshot };
  const patch = <T extends { id: string }>(items: T[], ids: string[] = []) => {
    const selected = new Set(ids), present = new Set(items.map(item => item.id));
    return { upsert: items.filter(item => selected.has(item.id)), removed: ids.filter(id => !present.has(id)) };
  };
  const sessions = snapshot.sessions;
  return { fromVersion, version, reset: false, replaceLocalSessions: true, changedIds, changes: {
    ...(changedIds.tasks && { tasks: patch(snapshot.tasks, changedIds.tasks) }),
    devices: patch(snapshot.devices, [...new Set(['local', ...changedIds.devices || []])]),
    sessions: patch(sessions, [...new Set([...changedIds.sessions || [], ...sessions.filter(session => session.deviceId === 'local').map(session => session.id)])]),
    ...(changedIds.handoffs && { handoffs: patch(snapshot.handoffs, changedIds.handoffs) }),
    ...(changedIds.executions && { executions: patch(snapshot.executions || [], changedIds.executions) }),
    ...(changedIds.directoryRequests && { directoryRequests: patch(snapshot.directoryRequests || [], changedIds.directoryRequests) }),
    ...(changedIds.gitRequests && { gitRequests: patch(snapshot.gitRequests || [], changedIds.gitRequests) })
  } };
}
