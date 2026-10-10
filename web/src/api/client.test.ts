import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, subscribeTaskCenterUpdates } from './client.js';

afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); });

it('decodes UTF-8 and CRLF split across network packets, ignores heartbeats and releases the reader', async () => {
  sessionStorage.setItem('bugflow.sessionToken', 'test');
  const source = ': keep-alive\r\n\r\nid: 2\r\nevent: task-center\r\ndata: {"version":2,"changes":{"tasks":["中文任务"]}}\r\n\r\n';
  const bytes = new TextEncoder().encode(source), cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); }, cancel });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })));
  const receive = vi.fn();
  await subscribeTaskCenterUpdates(0, receive, new AbortController().signal);
  expect(receive).toHaveBeenCalledTimes(1);
  expect(receive).toHaveBeenCalledWith(2, { version: 2, changes: { tasks: ['中文任务'] } });
  expect(body.locked).toBe(false);
});

it('rejects malformed event versions instead of advancing the resume cursor', async () => {
  sessionStorage.setItem('bugflow.sessionToken', 'test');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('id: 2\nevent: task-center\ndata: {"version":3}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })));
  const receive = vi.fn();
  await expect(subscribeTaskCenterUpdates(0, receive, new AbortController().signal)).rejects.toThrow('实时同步版本无效');
  expect(receive).not.toHaveBeenCalled();
});

it('does not open an unauthenticated stream and removes expired credentials', async () => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  await expect(subscribeTaskCenterUpdates(0, vi.fn(), new AbortController().signal)).rejects.toBeInstanceOf(ApiError);
  expect(fetchMock).not.toHaveBeenCalled();
  sessionStorage.setItem('bugflow.sessionToken', 'expired');
  fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
  await expect(subscribeTaskCenterUpdates(0, vi.fn(), new AbortController().signal)).rejects.toMatchObject({ status: 401 });
  expect(sessionStorage.getItem('bugflow.sessionToken')).toBeNull();
});
