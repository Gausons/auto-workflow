import type { TaskCenterUpdate } from '../../../shared/taskCenterSync.js';

const SESSION_TOKEN_KEY = 'bugflow.sessionToken';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}, authorization?: string): Promise<T> {
  const sessionToken = sessionStorage.getItem(SESSION_TOKEN_KEY);
  const token = authorization ?? sessionToken;
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && authorization === undefined) sessionStorage.removeItem(SESSION_TOKEN_KEY);
    const message = typeof data === 'object' && data !== null && 'message' in data && typeof data.message === 'string'
      ? data.message
      : `请求失败：${response.status}`;
    throw new ApiError(message, response.status);
  }
  return data as T;
}

export async function subscribeTaskCenterUpdates(since: number, onVersion: (version: number, update: TaskCenterUpdate) => void, signal: AbortSignal): Promise<void> {
  const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
  if (!token) throw new ApiError('请登录个人账号', 401);
  const response = await fetch(`/api/task-center/updates?since=${encodeURIComponent(String(since))}`, {
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` }, signal
  });
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    if (response.status === 401) sessionStorage.removeItem(SESSION_TOKEN_KEY);
    throw new ApiError(`实时同步连接失败：${response.status}`, response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      pending = (pending + decoder.decode(value, { stream: !done })).replaceAll('\r\n', '\n');
      if (pending.length > 1_000_000) throw new Error('实时同步事件超过大小限制');
      let boundary = pending.indexOf('\n\n');
      while (boundary >= 0) {
        const event = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const lines = event.split('\n');
        const type = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
        if (type === 'task-center') {
          const id = lines.find(line => line.startsWith('id:'))?.slice(3).trim();
          const version = Number(id);
          const update: unknown = JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
          if (!id || !/^\d+$/.test(id) || !Number.isSafeInteger(version) || !update || typeof update !== 'object' || !('version' in update) || update.version !== version) throw new Error('实时同步版本无效');
          onVersion(version, update as TaskCenterUpdate);
        }
        boundary = pending.indexOf('\n\n');
      }
      if (done) return;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function saveSessionToken(token: string) {
  sessionStorage.setItem(SESSION_TOKEN_KEY, token);
}

export function clearSessionToken() {
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
}

export function hasSessionToken() {
  return Boolean(sessionStorage.getItem(SESSION_TOKEN_KEY));
}
