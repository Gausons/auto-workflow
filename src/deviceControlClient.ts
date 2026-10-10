import { setTimeout as delay } from 'node:timers/promises';
import { realtimeEvent, realtimeMaxPayload, realtimeProtocol, realtimeUrl, type SendExecutionFeedback } from '../shared/realtime.js';

export async function connectDeviceUpdates(options: {
  url: URL; token: string; deviceId: string; signal: AbortSignal; wake: () => void;
  onFeedback?: (send: SendExecutionFeedback | undefined) => void; onReady?: () => void;
}) {
  if (options.signal.aborted) return;
  const socket = new WebSocket(realtimeUrl(options.url), realtimeProtocol);
  await new Promise<void>((resolve, reject) => {
    let ended = false, sequence = 0, ready = false;
    const pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    let timer = setTimeout(() => finish(new Error('设备实时连接认证超时')), 15_000);
    const finish = (error?: Error) => {
      if (ended) return;
      ended = true; clearTimeout(timer); options.onFeedback?.(undefined);
      options.signal.removeEventListener('abort', abort);
      socket.removeEventListener('open', open); socket.removeEventListener('message', message);
      socket.removeEventListener('error', failed); socket.removeEventListener('close', close);
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error || new Error('实时连接已断开，执行回报保留待重试')); }
      pending.clear(); socket.close();
      if (error) reject(error); else resolve();
    };
    const feedback: SendExecutionFeedback = input => new Promise<void>((done, fail) => {
      if (!ready || ended || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > realtimeMaxPayload) { fail(new Error('实时连接暂不可用，执行回报保留待重试')); return; }
      const id = String(++sequence);
      const message = JSON.stringify({ type: 'execution-report', id, input });
      if (new TextEncoder().encode(message).byteLength > realtimeMaxPayload) { fail(new Error('执行回报超过 8 MB，请核对原执行记录')); return; }
      const timeout = setTimeout(() => { pending.delete(id); fail(new Error('执行回报确认超时，保留回执待重试')); }, 15_000);
      pending.set(id, { resolve: done, reject: fail, timer: timeout });
      try { socket.send(message); }
      catch (error) { clearTimeout(timeout); pending.delete(id); fail(error instanceof Error ? error : new Error('执行回报发送失败')); }
    });
    const abort = () => finish();
    const open = () => socket.send(JSON.stringify({ type: 'subscribe', channel: 'device-control', token: options.token, deviceId: options.deviceId }));
    const message = (event: MessageEvent<unknown>) => {
      try {
        clearTimeout(timer); timer = setTimeout(() => finish(new Error('设备实时连接心跳超时')), 45_000);
        if (typeof event.data !== 'string' || event.data.length > 1_000_000) throw new Error('设备实时消息无效');
        const input: unknown = JSON.parse(event.data);
        if (!input || typeof input !== 'object' || !('type' in input)) throw new Error('设备实时消息无效');
        if (input.type === 'heartbeat') { socket.send(JSON.stringify({ type: 'pong' })); return; }
        if (input.type === 'ready' && 'channel' in input && input.channel === 'device-control') {
          ready = true; options.onReady?.(); options.onFeedback?.(feedback); options.wake(); return;
        }
        if (input.type === 'error' && 'status' in input && typeof input.status === 'number') throw Object.assign(new Error('message' in input ? String(input.message) : '设备实时连接失败'), { status: input.status });
        if (input.type === 'report-ack' && 'id' in input && typeof input.id === 'string' && 'status' in input && typeof input.status === 'number') {
          const item = pending.get(input.id);
          if (item) { clearTimeout(item.timer); pending.delete(input.id);
            if (input.status === 200) item.resolve();
            else item.reject(Object.assign(new Error('message' in input ? String(input.message) : '执行回报失败'), { status: input.status }));
          }
          return;
        }
        if (realtimeEvent(input).type !== 'device-control') throw new Error('设备实时订阅不匹配');
        options.wake();
      } catch (error) { finish(error instanceof Error ? error : new Error('设备实时消息无效')); }
    };
    const failed = () => finish(new Error('设备 WebSocket 连接失败'));
    const close = (event: CloseEvent) => finish([4401, 4403].includes(event.code) ? Object.assign(new Error('设备实时连接权限已失效'), { status: event.code === 4401 ? 401 : 403 }) : undefined);
    socket.addEventListener('open', open); socket.addEventListener('message', message);
    socket.addEventListener('error', failed); socket.addEventListener('close', close);
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
  });
}

export async function watchDeviceUpdates(options: Parameters<typeof connectDeviceUpdates>[0] & { onError: (error: unknown) => void }) {
  let backoff = 1000, disconnected = false;
  while (!options.signal.aborted) {
    try {
      await connectDeviceUpdates({ ...options, onReady() { backoff = 1000; disconnected = false; options.onReady?.(); } });
      if (!options.signal.aborted) throw new Error('设备实时连接已关闭');
    } catch (error) {
      if (options.signal.aborted) return;
      const status = error instanceof Error && 'status' in error ? error.status : undefined;
      if (status === 401 || status === 403) throw error;
      if (!disconnected) { options.onError(error); disconnected = true; }
    }
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
  pollMs?: number; heartbeatMs?: number; onControlsWake?: (wake: () => void) => void;
}) {
  const stop = new AbortController(), signal = stop.signal;
  const abort = () => stop.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) stop.abort();
  const work = createWake(signal, options.pollMs ?? 3000), controls = createWake(signal, options.pollMs ?? 3000);
  const heartbeat = createWake(signal, options.heartbeatMs ?? 30_000);
  options.onControlsWake?.(() => controls.wake());
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
  finally { options.onControlsWake?.(() => {}); stop.abort(); options.signal.removeEventListener('abort', abort); await Promise.allSettled(loops); }
}
