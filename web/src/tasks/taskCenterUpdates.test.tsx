import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTaskCenterUpdates } from './taskCenterUpdates.js';
import { taskCenterDelta, type TaskCenterDelta } from '../../../shared/taskCenterSync.js';
import type { Task, TaskCenterData } from '../../../shared/taskTypes.js';

const key = ['task-center', 'snapshot'] as const;
const task = (id: string, title: string): Task => ({ id, title, content: title, status: 'ready', revision: 1, contextVersion: 1, sessionIds: [], events: [], createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' });
const data = (version = 0, tasks: Task[] = []): TaskCenterData => ({ syncVersion: version, tasks, devices: [], sessions: [], handoffs: [], executions: [] });
const response = (delta: TaskCenterDelta) => new Response(JSON.stringify(delta), { headers: { 'Content-Type': 'application/json' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

function setup(read: (since: number, signal: AbortSignal) => Promise<Response>, base = data()) {
  sessionStorage.setItem('bugflow.sessionToken', 'test');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(key, base);
  const sockets: Socket[] = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    constructor() {
      super(); sockets.push(this);
      queueMicrotask(() => {
        if (this.readyState === 3) return;
        this.readyState = 1; this.dispatchEvent(new Event('open'));
        this.receive({ type: 'ready', channel: 'task-center' });
      });
    }
    send(value: string) { this.sent.push(value); }
    close() { this.readyState = 3; }
    disconnect() { this.close(); this.dispatchEvent(new CloseEvent('close', { code: 1006 })); }
    receive(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  }
  vi.stubGlobal('WebSocket', Socket);
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const signal = init!.signal as AbortSignal;
    if (url.startsWith('/api/task-center/changes?')) return read(Number(new URL(url, 'http://localhost').searchParams.get('since')), signal);
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  function Probe() {
    const snapshot = useQuery<TaskCenterData>({ queryKey: key, enabled: false });
    useTaskCenterUpdates(true, snapshot.data?.syncVersion);
    return <p>{snapshot.data?.tasks.map(item => item.title).join('、') || '没有任务'}</p>;
  }
  const view = render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
  const notify = async (version: number, reset = false) => {
    await act(async () => { await Promise.resolve(); sockets.at(-1)!.receive({ type: 'task-center', version, reset }); });
  };
  return { client, fetchMock, sockets, notify, ...view };
}

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it('merges entity changes, coalesces notifications and keeps one WebSocket as the cache version advances', async () => {
  const pending = deferred<Response>(), read = vi.fn(() => pending.promise);
  const { client, fetchMock, sockets, notify } = setup(read, data(0, [task('keep', '保留任务')]));
  await notify(1); await notify(2); await notify(2);
  await act(async () => pending.resolve(response(taskCenterDelta(data(2, [task('new', '新增任务')]), 0, { tasks: ['new'] }, false))));
  await screen.findByText('保留任务、新增任务');
  expect(client.getQueryData<TaskCenterData>(key)?.syncVersion).toBe(2);
  expect(read).toHaveBeenCalledTimes(1);
  expect(sockets).toHaveLength(1);
  await notify(2);
  expect(read).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/task-center')).toBe(false);
});

it('does not lose a notification that arrives while the previous cache merge is finishing', async () => {
  const read = vi.fn().mockImplementation((since: number) => Promise.resolve(response(taskCenterDelta(data(since + 1, [task('same', since === 0 ? '第一版' : '第二版')]), since, { tasks: ['same'] }, false))));
  const { client, notify, sockets } = setup(read);
  let notified = false;
  const unsubscribe = client.getQueryCache().subscribe(event => {
    const current = event.query.state.data as TaskCenterData | undefined;
    if (current?.syncVersion === 1 && !notified) {
      notified = true;
      sockets[0].receive({ type: 'task-center', version: 2 });
    }
  });
  await notify(1);
  await screen.findByText('第二版');
  unsubscribe();
  expect(read.mock.calls.map(([since]) => since)).toEqual([0, 1]);
});

it('retries a failed incremental read without waiting for another notification', async () => {
  const read = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValue(response(taskCenterDelta(data(1, [task('new', '恢复成功')]), 0, { tasks: ['new'] }, false)));
  const { notify } = setup(read);
  await notify(1);
  await screen.findByText('恢复成功', {}, { timeout: 3000 });
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls.map(([since]) => since)).toEqual([0, 0]);
});

it('discards a delta whose base was replaced by a concurrent refresh and reads from the new version', async () => {
  const pending = deferred<Response>();
  const read = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(response(taskCenterDelta(data(3, [task('new', '最新任务')]), 2, { tasks: ['new'] }, false)));
  const { client, notify } = setup(read);
  await notify(3);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  await act(async () => client.setQueryData(key, data(2, [task('new', '并发刷新')])));
  await act(async () => pending.resolve(response(taskCenterDelta(data(1, [task('old', '过期任务')]), 0, { tasks: ['old'] }, false))));
  await screen.findByText('最新任务');
  expect(screen.queryByText('过期任务')).toBeNull();
  expect(read.mock.calls.map(([since]) => since)).toEqual([0, 2]);
});

it('reconnects using the last applied version and handles expired history through an explicit reset', async () => {
  const read = vi.fn().mockResolvedValue(response(taskCenterDelta(data(5, [task('only', '权威快照')]), 0, {}, true)));
  const { notify, sockets } = setup(read, data(0, [task('old', '旧任务')]));
  await notify(5, true);
  await screen.findByText('权威快照');
  expect(screen.queryByText('旧任务')).toBeNull();
  await act(async () => sockets[0].disconnect());
  await waitFor(() => expect(sockets).toHaveLength(2), { timeout: 3000 });
  expect(sockets.map(socket => JSON.parse(socket.sent[0]).since)).toEqual([0, 5]);
});

it('stops on authentication failure and aborts pending work on unmount', async () => {
  const read = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
  const first = setup(read);
  await first.notify(1);
  await waitFor(() => expect(first.sockets[0].readyState).toBe(3));
  expect(read).toHaveBeenCalledTimes(1);
  first.unmount();
  const pending = deferred<Response>();
  const second = setup(() => pending.promise);
  await second.notify(1);
  second.unmount();
  await act(async () => pending.resolve(response(taskCenterDelta(data(1, [task('late', '晚到任务')]), 0, { tasks: ['late'] }, false))));
  expect(second.client.getQueryData<TaskCenterData>(key)?.syncVersion).toBe(0);
  expect(second.sockets[0].readyState).toBe(3);
});

it('heartbeats leave unrelated history details fresh while a changed session invalidates its own detail', async () => {
  const read = vi.fn().mockResolvedValueOnce(response(taskCenterDelta(data(1), 0, { devices: ['remote'] }, false))).mockResolvedValue(response(taskCenterDelta(data(2), 1, { sessions: ['changed'] }, false)));
  const { client, notify } = setup(read);
  client.setQueryData(['history', 'detail', 'changed'], { messages: [] });
  client.setQueryData(['history', 'detail', 'other'], { messages: [] });
  await notify(1);
  await waitFor(() => expect(client.getQueryData<TaskCenterData>(key)?.syncVersion).toBe(1));
  expect(client.getQueryState(['history', 'detail', 'changed'])?.isInvalidated).toBe(false);
  await notify(2);
  await waitFor(() => expect(client.getQueryState(['history', 'detail', 'changed'])?.isInvalidated).toBe(true));
  expect(client.getQueryState(['history', 'detail', 'other'])?.isInvalidated).toBe(false);
});
