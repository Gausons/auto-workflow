import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, ApiError } from '../api/client.js';
import type { TaskCenterData } from '../../../shared/taskTypes.js';
import { useTaskCenterUpdates } from './taskCenterUpdates.js';
import { createCompletionTracker, type CompletionNotice } from './completionTracker.js';
import styles from './CompletionNotifications.module.css';

const denied = (error: unknown) => error instanceof ApiError && [401, 403].includes(error.status);
const snapshotKey = ['task-center', 'snapshot'] as const;
export function CompletionNotifications({ activeSessionId, onOpen }: { activeSessionId?: string; onOpen(notice: CompletionNotice): void }) {
  const client = useQueryClient();
  const activeSession = useRef(activeSessionId);
  const activeRoom = useRef('');
  useLayoutEffect(() => {
    const viewing = (event: Event) => { activeRoom.current = (event as CustomEvent<{ roomId?: string }>).detail?.roomId || ''; };
    window.addEventListener('bugflow:active-group-chat', viewing);
    return () => window.removeEventListener('bugflow:active-group-chat', viewing);
  }, []);
  useLayoutEffect(() => { activeSession.current = activeSessionId; }, [activeSessionId]);
  const [notices, setNotices] = useState<CompletionNotice[]>([]);
  const snapshot = useQuery({ queryKey: snapshotKey, queryFn: ({ signal }) => apiRequest<TaskCenterData>('/api/task-center', { signal }), staleTime: Infinity });
  useTaskCenterUpdates(!denied(snapshot.error), snapshot.data?.syncVersion);
  useEffect(() => {
    const observe = createCompletionTracker();
    const consume = () => {
      const query = client.getQueryState<TaskCenterData>(snapshotKey);
      if (denied(query?.error)) { setNotices([]); return; }
      if (!query?.data) return;
      const data = query.data;
      // Always consume completions so ones already seen in the session do not replay after navigation.
      const additions = observe(data).filter(notice => {
        const room = data.groupChatRooms?.find(item => item.id === activeRoom.current);
        if (notice.taskId && room?.messages.some(message => message.taskId === notice.taskId)) return false;
        const id = activeSession.current;
        if (!id) return true;
        if (notice.sessionId) return notice.sessionId !== id;
        return !data.tasks.some(task => task.id === notice.taskId && task.sessionIds.includes(id)) &&
          !data.sessions.some(session => session.id === id && session.taskId === notice.taskId);
      });
      if (additions.length) setNotices(current => [...additions.filter(item => !current.some(existing => existing.id === item.id)), ...current]);
    };
    consume();
    // Observe each cache commit, even when React batches several renders into one.
    return client.getQueryCache().subscribe(event => {
      if (event.type === 'updated' && event.query.queryKey.length === 2 && event.query.queryKey[0] === snapshotKey[0] && event.query.queryKey[1] === snapshotKey[1]) consume();
    });
  }, [client]);
  const dismiss = (id: string) => setNotices(current => current.filter(item => item.id !== id));
  if (denied(snapshot.error)) return null;
  return <section className={styles.stack} aria-label="完成通知" aria-live="polite" aria-relevant="additions">
    {notices.map(notice => <div className={styles.notice} key={notice.id} role="status">
      <span className={styles.icon} aria-hidden="true">✓</span>
      <div className={styles.content}><strong>{notice.heading}</strong><p>{notice.title}</p><button type="button" className={styles.view} onClick={() => { onOpen(notice); dismiss(notice.id); }}>{notice.sessionId ? '查看会话' : '查看任务'}</button></div>
      <button type="button" className={styles.close} aria-label={`关闭完成通知：${notice.title}`} onClick={() => dismiss(notice.id)}>×</button>
    </div>)}
  </section>;
}
