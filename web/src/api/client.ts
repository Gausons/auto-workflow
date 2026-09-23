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

export function saveSessionToken(token: string) {
  sessionStorage.setItem(SESSION_TOKEN_KEY, token);
}

export function clearSessionToken() {
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
}

export function hasSessionToken() {
  return Boolean(sessionStorage.getItem(SESSION_TOKEN_KEY));
}
