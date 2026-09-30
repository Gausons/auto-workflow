import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { subscribeTaskCenterUpdates } from '../api/client.js';

const snapshotKey = ['task-center', 'snapshot'] as const;

export function useTaskCenterUpdates(active: boolean, syncVersion: number | undefined) {
  const client = useQueryClient();
  useEffect(() => {
    if (!active || !Number.isSafeInteger(syncVersion)) return;
    const controller = new AbortController();
    let cursor = syncVersion || 0;
    const run = async () => {
      let delay = 500;
      while (!controller.signal.aborted) {
        try {
          await subscribeTaskCenterUpdates(cursor, version => {
            if (version <= cursor) return;
            cursor = version;
            void client.invalidateQueries({ queryKey: snapshotKey });
          }, controller.signal);
          delay = 500;
        } catch (error) {
          if (controller.signal.aborted) return;
          await new Promise(resolve => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 10_000);
        }
      }
    };
    void run();
    return () => controller.abort();
  }, [active, client, syncVersion]);
}
