import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, subscribeTaskCenterUpdates } from './client.js';

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  constructor(readonly url: URL, readonly protocol: string) { super(); Socket.instances.push(this); }
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  receive(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}

beforeEach(() => { Socket.instances = []; vi.stubGlobal('WebSocket', Socket); });
afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); });

it('uses WebSocket with first-frame authentication, responds to heartbeat and delivers Unicode updates', async () => {
  sessionStorage.setItem('bugflow.sessionToken', 'test');
  const controller = new AbortController(), receive = vi.fn();
  const running = subscribeTaskCenterUpdates(1, receive, controller.signal);
  const socket = Socket.instances[0];
  expect(socket.url.protocol).toBe('ws:'); expect(socket.url.pathname).toBe('/api/realtime'); expect(socket.url.search).toBe('');
  expect(socket.protocol).toBe('workbench.v1'); socket.open();
  expect(JSON.parse(socket.sent[0])).toEqual({ type: 'subscribe', channel: 'task-center', token: 'test', since: 1 });
  socket.receive({ type: 'ready', channel: 'task-center' }); socket.receive({ type: 'heartbeat' });
  expect(socket.sent[1]).toBe('{"type":"pong"}');
  socket.receive({ type: 'task-center', version: 2, changes: { tasks: ['中文任务😀'] } });
  expect(receive).toHaveBeenCalledWith(2, { type: 'task-center', version: 2, changes: { tasks: ['中文任务😀'] } });
  controller.abort(); await running;
  socket.receive({ type: 'task-center', version: 3 }); expect(receive).toHaveBeenCalledTimes(1); expect(socket.readyState).toBe(3);
});

it('rejects malformed versions and unexpected channels without advancing the resume cursor', async () => {
  sessionStorage.setItem('bugflow.sessionToken', 'test');
  for (const message of [{ type: 'task-center', version: -1 }, { type: 'task-center', version: '2' }, { type: 'device-control', version: 2 }]) {
    const receive = vi.fn();
    const running = subscribeTaskCenterUpdates(0, receive, new AbortController().signal);
    Socket.instances.at(-1)!.receive(message);
    await expect(running).rejects.toThrow(/实时同步/); expect(receive).not.toHaveBeenCalled();
  }
});

it('does not connect without a login and removes expired credentials', async () => {
  await expect(subscribeTaskCenterUpdates(0, vi.fn(), new AbortController().signal)).rejects.toBeInstanceOf(ApiError);
  expect(Socket.instances).toHaveLength(0);
  sessionStorage.setItem('bugflow.sessionToken', 'expired');
  const running = subscribeTaskCenterUpdates(0, vi.fn(), new AbortController().signal);
  Socket.instances[0].receive({ type: 'error', status: 401, message: 'expired' });
  await expect(running).rejects.toMatchObject({ status: 401 }); expect(sessionStorage.getItem('bugflow.sessionToken')).toBeNull();
});

it('recognizes authorization close codes even if the error frame was lost', async () => {
  sessionStorage.setItem('bugflow.sessionToken', 'expired');
  const running = subscribeTaskCenterUpdates(0, vi.fn(), new AbortController().signal);
  Socket.instances[0].dispatchEvent(new CloseEvent('close', { code: 4403 }));
  await expect(running).rejects.toMatchObject({ status: 403 });
});
