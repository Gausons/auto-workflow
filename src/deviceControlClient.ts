import { setTimeout as delay } from 'node:timers/promises';

// Bound both a stalled connection and a stalled response body. SSE comments
// refresh the deadline too; no command is carried or replayed by this stream.
export async function readDeviceUpdates(response: Response, wake: () => void) {
  if (!response.ok) throw Object.assign(new Error('设备通知连接失败'), { status: response.status });
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('设备通知响应格式无效');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      // Normalize complete lines, preserving a trailing CR across network chunks.
      pending = pending.replace(/\r\n/g, '\n');
      if (pending.length > 65_536) throw new Error('设备通知超出长度限制');
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        const lines = frame.split('\n');
        if (!lines.includes('event: device-control')) continue;
        const data = JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')) as { version?: unknown };
        if (!Number.isSafeInteger(data?.version) || Number(data.version) < 0) throw new Error('设备通知版本无效');
        wake();
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function watchDeviceUpdates(options: { url: URL; token: string; signal: AbortSignal; wake: () => void; onError: (error: unknown) => void }) {
  let backoff = 1000, disconnected = false;
  while (!options.signal.aborted) {
    const connection = new AbortController();
    const abort = () => connection.abort();
    options.signal.addEventListener('abort', abort, { once: true });
    let idle = setTimeout(abort, 45_000);
    try {
      const response = await fetch(options.url, { headers: { Authorization: `Bearer ${options.token}`, Accept: 'text/event-stream' },
        signal: connection.signal });
      if (response.ok) { backoff = 1000; disconnected = false; }
      // Reset the timeout on bytes, including keep-alive comments.
      const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        clearTimeout(idle); idle = setTimeout(abort, 45_000); controller.enqueue(chunk);
      } }));
      await readDeviceUpdates(new Response(body, { status: response.status, headers: response.headers }), options.wake);
      if (!options.signal.aborted) throw new Error('设备通知连接已关闭');
    } catch (error) {
      if (options.signal.aborted) return;
      const status = error instanceof Error && 'status' in error ? error.status : undefined;
      if (status === 401 || status === 403) throw error;
      if (!disconnected) { options.onError(error); disconnected = true; }
    } finally { clearTimeout(idle); options.signal.removeEventListener('abort', abort); connection.abort(); }
    await delay(backoff, undefined, { signal: options.signal }).catch(error => { if (!options.signal.aborted) throw error; });
    backoff = Math.min(backoff * 2, 30_000);
  }
}

function createWake(signal: AbortSignal, interval: number) {
  let dirty = true, release: (() => void) | undefined;
  return {
    wake() { dirty = true; release?.(); },
    async wait() {
      if (signal.aborted) return;
      if (!dirty) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); release = undefined; resolve(); };
        const timer = setTimeout(finish, interval);
        release = finish; signal.addEventListener('abort', finish, { once: true });
      });
      dirty = false;
    }
  };
}

// Work may wait for a native directory picker or context transfer. Controls have
// their own serialized loop, so those waits cannot hold up stop/approval calls.
export async function runDeviceControl(options: {
  signal: AbortSignal; work: () => Promise<void>; controls: () => Promise<void>; heartbeat: () => Promise<void>;
  subscribe: (wake: () => void, signal: AbortSignal) => Promise<void>; onError: (error: unknown) => void;
  pollMs?: number; heartbeatMs?: number;
}) {
  const stop = new AbortController(), signal = stop.signal;
  const abort = () => stop.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) stop.abort();
  const work = createWake(signal, options.pollMs ?? 3000), controls = createWake(signal, options.pollMs ?? 3000);
  const heartbeat = createWake(signal, options.heartbeatMs ?? 30_000);
  const loop = async (wake: ReturnType<typeof createWake>, action: () => Promise<void>) => {
    while (!signal.aborted) {
      await wake.wait(); if (signal.aborted) return;
      try { await action(); } catch (error) { if (!signal.aborted) options.onError(error); }
    }
  };
  const loops = [loop(work, options.work), loop(controls, options.controls), loop(heartbeat, options.heartbeat),
    options.subscribe(() => { work.wake(); controls.wake(); }, signal)];
  try { await Promise.all(loops); }
  catch (error) { options.onError(error); throw error; }
  finally { stop.abort(); options.signal.removeEventListener('abort', abort); await Promise.allSettled(loops); }
}
