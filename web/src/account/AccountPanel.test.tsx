import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPanel } from './AccountPanel.js';

function renderAccount(reload = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><AccountPanel reload={reload} /></QueryClientProvider>);
  return reload;
}

describe('AccountPanel', () => {
  beforeEach(() => { sessionStorage.clear(); });
  afterEach(() => { cleanup(); delete (window as Window & { __bugflowIdentity?: unknown }).__bugflowIdentity; vi.unstubAllGlobals(); });

  it('receives the authenticated identity from bootstrap', async () => {
    renderAccount();
    window.dispatchEvent(new CustomEvent('bugflow:bootstrap', { detail: { user: { username: 'owner', displayName: '负责人' } } }));
    expect(await screen.findByText('owner · 负责人')).toBeTruthy();
  });

  it('changes the password without retrying and clears the current session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    sessionStorage.setItem('bugflow.sessionToken', 'member-token');
    const reload = renderAccount();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('当前密码'), 'old-password');
    await user.type(screen.getByLabelText('新密码（12–128 位）'), 'replacement-password');
    await user.click(screen.getByRole('button', { name: '修改密码并退出所有会话' }));

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(sessionStorage.getItem('bugflow.sessionToken')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
