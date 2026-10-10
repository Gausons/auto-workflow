import { realtimeEvent, realtimeProtocol, realtimeUrl } from '../../../shared/realtime.js';
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
  if (signal.aborted) return;
  const socket = new WebSocket(realtimeUrl(new URL('/api/realtime', location.href)), realtimeProtocol);
  await new Promise<void>((resolve, reject) => {
    let timer = setTimeout(() => finish(new Error('实时连接认证超时')), 15_000), ended = false;
    const finish = (error?: Error) => {
      if (ended) return;
      ended = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      socket.removeEventListener('open', open); socket.removeEventListener('message', message);
      socket.removeEventListener('error', failed); socket.removeEventListener('close', close);
      socket.close();
      if (error) { if (error instanceof ApiError && error.status === 401) sessionStorage.removeItem(SESSION_TOKEN_KEY); reject(error); }
      else resolve();
    };
    const abort = () => finish();
    const open = () => socket.send(JSON.stringify({ type: 'subscribe', channel: 'task-center', token, since }));
    const message = (event: MessageEvent<unknown>) => {
      try {
        clearTimeout(timer); timer = setTimeout(() => finish(new Error('实时连接心跳超时')), 45_000);
        if (typeof event.data !== 'string' || event.data.length > 1_000_000) throw new Error('实时同步消息无效');
        const input: unknown = JSON.parse(event.data);
        if (!input || typeof input !== 'object' || !('type' in input)) throw new Error('实时同步消息无效');
        if (input.type === 'heartbeat') { socket.send(JSON.stringify({ type: 'pong' })); return; }
        if (input.type === 'ready' && 'channel' in input && input.channel === 'task-center') return;
        if (input.type === 'error' && 'status' in input && typeof input.status === 'number') {
          throw new ApiError('message' in input && typeof input.message === 'string' ? input.message : '实时连接失败', input.status);
        }
        const update = realtimeEvent(input);
        if (update.type !== 'task-center') throw new Error('实时同步订阅不匹配');
        onVersion(update.version, update);
      } catch (error) { finish(error instanceof Error ? error : new Error('实时同步消息无效')); }
    };
    const failed = () => finish(new Error('WebSocket 实时连接失败'));
    const close = (event: CloseEvent) => finish([4401, 4403].includes(event.code) ? new ApiError('实时连接权限已失效', event.code === 4401 ? 401 : 403) : undefined);
    socket.addEventListener('open', open); socket.addEventListener('message', message);
    socket.addEventListener('error', failed); socket.addEventListener('close', close);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
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
