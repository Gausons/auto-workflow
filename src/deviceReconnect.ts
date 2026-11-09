import { setTimeout as delay } from 'node:timers/promises';

export async function withDeviceConnectionTimeout<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  const timer = setTimeout(() => controller.abort(new DOMException('设备连接请求超时', 'TimeoutError')), 30_000);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try { return await operation(controller.signal); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

export function createDeviceReconnectBackoff() {
  let interval = 1000;
  return {
    reset() { interval = 1000; },
    next() {
      const wait = Math.min(30_000, Math.round(interval * (0.8 + Math.random() * 0.4)));
      interval = Math.min(interval * 2, 30_000);
      return wait;
    }
  };
}

// Only use for identity reads and idempotent presence registration. Never wrap
// token exchange, execution claims or Agent commands in transport retries.
export async function retryDeviceConnection<T>(operation: () => Promise<T>, options: {
  signal: AbortSignal; onRetry: (error: unknown, waitMs: number) => void;
}) {
  const backoff = createDeviceReconnectBackoff();
  while (true) {
    options.signal.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      options.signal.throwIfAborted();
      const status = error instanceof Error && 'status' in error ? error.status : undefined;
      const retryable = typeof status === 'number'
        ? [408, 429].includes(status) || status >= 500 && status < 600
        : error instanceof TypeError || error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      if (!retryable) throw error;
      const wait = backoff.next();
      options.onRetry(error, wait);
      await delay(wait, undefined, { signal: options.signal });
    }
  }
}
