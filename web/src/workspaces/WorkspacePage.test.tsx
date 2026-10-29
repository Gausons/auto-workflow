import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspacePage } from './WorkspacePage.js';

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.unstubAllGlobals(); });
function setup(role = 'owner', failure = false) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let invited = false;
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    let data: unknown = {};
    if (init?.method === 'POST') {
      requests.push({ path: input, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (failure) return new Response(JSON.stringify({ message: '服务暂时不可用' }), { status: 503 });
      invited = true; data = { id: 'invitation' };
    } else if (input === '/api/workspaces') data = { currentId: 'team-1', workspaces: [{ id: 'team-1', name: '研发团队', kind: 'team', role }], invitations: [] };
    else if (input === '/api/bootstrap') data = { user: { id: 'me', displayName: '小王' } };
    else if (input === '/api/workspaces/members') data = { members: [{ id: 'me', displayName: '小王', username: 'wang', role, enabled: 1 }, { id: 'other', displayName: '小李', username: 'li', role: 'viewer', enabled: 1 }], invitations: invited ? [{ id: 'invitation', username: 'new-user', role: 'operator', expiresAt: Date.now() + 86400000 }] : [] };
    else if (input === '/api/task-center') data = { tasks: [{ id: 'task-1', title: '打磨协作体验', status: 'running', updatedAt: '2026-10-30T08:00:00Z', events: [] }] };
    return new Response(JSON.stringify(data), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><MemoryRouter><WorkspacePage /></MemoryRouter></QueryClientProvider>);
  return { requests, fetchMock };
}
it('shows real team tasks, searches and opens the selected task', async () => {
  setup(); const user = userEvent.setup();
  expect(await screen.findByRole('heading', { name: '研发团队' })).toBeTruthy();
  const listener = vi.fn(); window.addEventListener('bugflow:open-task', listener);
  await user.click(await screen.findByRole('button', { name: /打磨协作体验/ }));
  expect(listener).toHaveBeenCalledOnce(); window.removeEventListener('bugflow:open-task', listener);
  await user.type(screen.getByRole('textbox', { name: '搜索团队任务' }), '不存在');
  expect(screen.getByText('没有匹配的任务')).toBeTruthy();
});
it('creates an in-app invitation with explicit role and refreshes the pending list', async () => {
  const { requests } = setup(); const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /^成员/ }));
  await user.type(screen.getByLabelText('账号用户名'), 'new-user');
  await user.click(screen.getByRole('button', { name: '邀请成员' }));
  await waitFor(() => expect(requests).toEqual([{ path: '/api/workspaces/invitations', body: { username: 'new-user', role: 'operator' } }]));
  expect(await screen.findByText('new-user')).toBeTruthy();
});
it('viewers can read members but cannot invite or edit roles', async () => {
  setup('viewer'); const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /^成员/ }));
  expect(await screen.findByText('小李')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '邀请成员' })).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('link', { name: /新建任务/ })).toBeNull();
});
it('failed invitation remains visible and is never retried automatically', async () => {
  const { requests } = setup('owner', true); const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /^成员/ }));
  await user.type(screen.getByLabelText('账号用户名'), 'new-user');
  await user.click(screen.getByRole('button', { name: '邀请成员' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '服务暂时不可用');
  expect(requests).toHaveLength(1);
  expect(screen.getByLabelText('账号用户名')).toHaveProperty('value', 'new-user');
});
