import type { QueryClient } from '@tanstack/react-query';
import type { TaskCenterData } from '../../../shared/taskTypes.js';

// The WebSocket-driven cache wakes only the matching request. HTTP remains the
// authority for results and expires stale requests during periodic reconciliation.
export async function waitForRemoteRequest<T extends { status: string }>(client: QueryClient, collection: 'gitRequests' | 'directoryRequests', id: string,
  initial: T, read: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const fingerprint = () => JSON.stringify(client.getQueryData<TaskCenterData>(['task-center', 'snapshot'])?.[collection]?.find(item => item.id === id));
  const deadline = Date.now() + timeoutMs;
  let result = initial, seen: string | undefined;
  while (['pending', 'running', 'selecting'].includes(result.status)) {
    if (signal?.aborted) throw new DOMException('已取消等待远端结果', 'AbortError');
    if (Date.now() >= deadline) throw new Error('等待远端结果超时，请检查连接器；重试时先核对原请求');
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (error?: Error) => {
        clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new DOMException('已取消等待远端结果', 'AbortError'));
      const timer = setTimeout(finish, Math.min(3000, deadline - Date.now()));
      const check = () => { if (fingerprint() !== seen) finish(); };
      unsubscribe = client.getQueryCache().subscribe(check);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else check();
    });
    seen = fingerprint();
    if (signal?.aborted) throw new DOMException('已取消等待远端结果', 'AbortError');
    if (Date.now() >= deadline) throw new Error('等待远端结果超时，请检查连接器；重试时先核对原请求');
    result = await read();
  }
  return result;
}
