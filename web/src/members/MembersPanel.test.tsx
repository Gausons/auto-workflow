import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MembersPanel } from './MembersPanel.js';

function renderMembers() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MembersPanel /></QueryClientProvider>);
}

describe('MembersPanel', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('loads members and audit records for an authorized owner', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path.endsWith('/audit')
      ? { events: [{ actorName: '负责人', action: 'auth.login', createdAt: '2026-09-23', target: 'owner' }] }
      : { members: [{ id: '1', username: 'owner', displayName: '负责人', role: 'owner', enabled: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);
    renderMembers();
    window.dispatchEvent(new CustomEvent('bugflow:bootstrap', { detail: { user: { role: 'owner' }, permissions: ['members.manage'] } }));

    expect(await screen.findByText('owner · 组织所有者')).toBeTruthy();
    expect(await screen.findByText('负责人 · auth.login')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not request protected data without member permission', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    renderMembers();
    window.dispatchEvent(new CustomEvent('bugflow:bootstrap', { detail: { user: { role: 'viewer' }, permissions: [] } }));
    expect(await screen.findByText('当前账号没有成员管理权限。')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
