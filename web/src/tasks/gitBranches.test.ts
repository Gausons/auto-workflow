import { afterEach, expect, it, vi } from 'vitest';
import { requestGitBranches } from './gitBranches.js';
import { QueryClient } from '@tanstack/react-query';

const project = { id: 'p', deviceId: 'remote', cwd: '/repo', online: true, gitBranches: true };
const client = new QueryClient();
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });
it('keeps the same mutation ID after an uncertain network response', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', result: { repository: true, current: 'feature', changes: 0, branches: ['feature'] } })));
  vi.stubGlobal('fetch', fetch);
  await expect(requestGitBranches(client, project, '', 'create', 'feature')).rejects.toThrow('network');
  expect((await requestGitBranches(client, project, '', 'create', 'feature')).current).toBe('feature');
  const first = JSON.parse(fetch.mock.calls[0]![1].body), second = JSON.parse(fetch.mock.calls[1]![1].body);
  expect(first.requestId).toBe(second.requestId);
});
it('reports offline devices and old connectors without queueing a request', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(requestGitBranches(client, { ...project, gitBranches: false }, '')).rejects.toThrow('升级');
  await expect(requestGitBranches(client, { ...project, online: false }, '')).rejects.toThrow('离线');
  expect(fetch).not.toHaveBeenCalled();
});
