import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiRequest, ApiError, subscribeTaskCenterUpdates } from '../api/client.js';
import { applyTaskCenterDelta, type TaskCenterDelta } from '../../../shared/taskCenterSync.js';
import type { TaskCenterData } from '../../../shared/taskTypes.js';

const snapshotKey = ['task-center', 'snapshot'] as const;
const denied = (error: unknown) => error instanceof ApiError && [401, 403].includes(error.status);
const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms);
  signal.addEventListener('abort', finish, { once: true });
  if (signal.aborted) finish();
});

function refreshDetails(client: QueryClient, delta: TaskCenterDelta, previous: TaskCenterData) {
  if (delta.reset) {
    void client.invalidateQueries({ queryKey: ['history'] });
    void client.invalidateQueries({ queryKey: ['task-center', 'session'] });
    return;
  }
  const changedSessions = new Set(delta.changedIds.sessions || []);
  const local = new Map(previous.sessions.filter(session => session.deviceId === 'local').map(session => [session.id, JSON.stringify(session)]));
  for (const session of delta.changes.sessions?.upsert || []) if (session.deviceId === 'local') {
    if (local.get(session.id) !== JSON.stringify(session)) changedSessions.add(session.id);
    local.delete(session.id);
  }
  for (const id of local.keys()) changedSessions.add(id);
  if (changedSessions.size) {
    void client.invalidateQueries({ queryKey: ['history', 'list'] });
    for (const id of changedSessions) {
      void client.invalidateQueries({ queryKey: ['history', 'detail', id] });
      void client.invalidateQueries({ queryKey: ['task-center', 'session', id] });
    }
  }
  if (delta.changedIds.devices?.length) void client.invalidateQueries({ queryKey: ['history', 'targets'] });
  if (delta.changes.executions) for (const execution of delta.changes.executions.upsert) {
    const id = execution.conversationId || execution.historySessionId;
    if (id) void client.invalidateQueries({ queryKey: ['history', 'continue', id] });
  }
}

export function useTaskCenterUpdates(active: boolean, syncVersion: number | undefined) {
  const client = useQueryClient();
  const ready = Number.isSafeInteger(syncVersion);
  useEffect(() => {
    if (!active || !ready) return;
    const controller = new AbortController(), { signal } = controller;
    let targetVersion = client.getQueryData<TaskCenterData>(snapshotKey)?.syncVersion || 0;
    let reset = false, syncing: Promise<void> | null = null;
    const synchronize = () => {
      if (syncing || signal.aborted) return;
      syncing = (async () => {
        let delay = 500;
        while (!signal.aborted) {
          const base = client.getQueryData<TaskCenterData>(snapshotKey);
          if (!base || (!reset && (base.syncVersion || 0) >= targetVersion)) return;
          try {
            // Prevent an older full read from replacing a newer incremental result.
            await client.cancelQueries({ queryKey: snapshotKey, exact: true });
            const since = client.getQueryData<TaskCenterData>(snapshotKey)?.syncVersion || 0;
            const requestedTarget = targetVersion;
            const delta = await apiRequest<TaskCenterDelta>(`/api/task-center/changes?since=${since}`, { signal });
            if (signal.aborted) return;
            if (delta.fromVersion !== since || !Number.isSafeInteger(delta.version) || delta.version < 0 || (!delta.reset && delta.version < since)) throw new Error('同步响应版本无效');
            if (!delta.reset && delta.version === since && targetVersion > since) throw new Error('同步响应尚未包含已通知的变更');
            await client.cancelQueries({ queryKey: snapshotKey, exact: true });
            let previous: TaskCenterData | undefined;
            client.setQueryData<TaskCenterData>(snapshotKey, current => {
              if (!current || (current.syncVersion || 0) !== since) return current;
              previous = current;
              return applyTaskCenterDelta(current, delta);
            });
            if (previous) {
              reset = false;
              targetVersion = delta.reset && targetVersion === requestedTarget ? delta.version : Math.max(targetVersion, delta.version);
              refreshDetails(client, delta, previous);
            }
            delay = 500;
          } catch (error) {
            if (signal.aborted) return;
            if (denied(error)) { controller.abort(); return; }
            await pause(delay, signal);
            delay = Math.min(delay * 2, 10_000);
          }
        }
      })().finally(() => {
        syncing = null;
        const current = client.getQueryData<TaskCenterData>(snapshotKey);
        if (!signal.aborted && current && (reset || (current.syncVersion || 0) < targetVersion)) synchronize();
      });
    };
    const run = async () => {
      let delay = 500;
      while (!signal.aborted) {
        try {
          const since = client.getQueryData<TaskCenterData>(snapshotKey)?.syncVersion || 0;
          await subscribeTaskCenterUpdates(since, (version, update) => {
            if (signal.aborted) return;
            if (update.reset) reset = true;
            targetVersion = Math.max(targetVersion, version);
            synchronize();
          }, signal);
          delay = 500;
        } catch (error) {
          if (signal.aborted) return;
          if (denied(error)) { controller.abort(); return; }
        }
        // Clean EOF also needs backoff; a closing server must not create a busy loop.
        await pause(delay, signal);
        delay = Math.min(delay * 2, 10_000);
      }
    };
    void run();
    return () => controller.abort();
  }, [active, client, ready]);
}
