import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { waitForRemoteRequest } from './remoteRequest.js';
import type { TaskCenterData } from '../../../shared/taskTypes.js';

const key = ['task-center', 'snapshot'];
const client = () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
function update(target: QueryClient, id: string, status: 'pending' | 'completed') {
  target.setQueryData<TaskCenterData>(key, { syncVersion: 1, tasks: [], devices: [], sessions: [], executions: [], handoffs: [],
    directoryRequests: [{ id, deviceId: 'remote', projectId: 'p', requestedBy: 'owner', status, createdAt: '', updatedAt: '' }] });
}
afterEach(() => vi.useRealTimers());

it('wakes immediately for the matching WebSocket-driven cache update and ignores unrelated requests', async () => {
  const target = client(), read = vi.fn().mockResolvedValue({ status: 'completed', cwd: '/selected' });
  const running = waitForRemoteRequest(target, 'directoryRequests', 'ours', { status: 'pending' }, read, 300_000);
  update(target, 'other', 'completed'); await Promise.resolve(); expect(read).not.toHaveBeenCalled();
  update(target, 'ours', 'completed');
  await expect(running).resolves.toEqual({ status: 'completed', cwd: '/selected' }); expect(read).toHaveBeenCalledTimes(1);
});

it('handles a result that arrived before waiting and reconciles a dropped notification', async () => {
  vi.useFakeTimers();
  const target = client(), read = vi.fn().mockResolvedValueOnce({ status: 'pending' }).mockResolvedValue({ status: 'completed' });
  update(target, 'ours', 'pending');
  const running = waitForRemoteRequest(target, 'directoryRequests', 'ours', { status: 'pending' }, read, 300_000);
  await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2999); expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); await expect(running).resolves.toEqual({ status: 'completed' });
});

it('aborts waits and removes listeners without reading or resubmitting a command', async () => {
  const target = client(), stop = new AbortController(), read = vi.fn();
  const running = waitForRemoteRequest(target, 'directoryRequests', 'ours', { status: 'pending' }, read, 300_000, stop.signal);
  stop.abort(); await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  update(target, 'ours', 'completed'); await Promise.resolve(); expect(read).not.toHaveBeenCalled();
});
