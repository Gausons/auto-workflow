import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthScreen } from './AuthScreen.js';

function renderAuth(reload = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><AuthScreen hasSession={false} reload={reload} /></QueryClientProvider>);
  return reload;
}

describe('AuthScreen', () => {
  beforeEach(() => { sessionStorage.clear(); });
  afterEach(() => { cleanup(); delete (window as Window & { __bugflowAuthError?: string }).__bugflowAuthError; vi.unstubAllGlobals(); });

  it('shows login when an expired session was rejected before React mounted', async () => {
    (window as Window & { __bugflowAuthError?: string }).__bugflowAuthError = '登录会话已失效';
    const client = new QueryClient();
    render(<QueryClientProvider client={client}><AuthScreen hasSession /></QueryClientProvider>);
    expect(await screen.findByRole('button', { name: '登录' })).toBeTruthy();
    expect(screen.getByText('登录会话已失效')).toBeTruthy();
  });

  it('logs in and stores the member session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: 'member-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const reload = renderAuth();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(sessionStorage.getItem('bugflow.sessionToken')).toBe('member-token');
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST' }));
  });

  it('shows a structured login error without storing a token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: '用户名或密码错误' }), { status: 401, headers: { 'Content-Type': 'application/json' } })));
    renderAuth();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('用户名或密码错误')).toBeTruthy();
    expect(sessionStorage.getItem('bugflow.sessionToken')).toBeNull();
  });

  it('initializes an owner and copies the identity into the login form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ tenant: { id: 'default' }, message: '组织所有者已创建' }), { status: 201, headers: { 'Content-Type': 'application/json' } })));
    renderAuth();
    const user = userEvent.setup();

    await user.click(screen.getByText('首次使用？初始化组织所有者'));
    await user.type(screen.getByLabelText('组织初始化令牌'), 'setup-token');
    await user.type(screen.getByLabelText('所有者用户名'), 'new-owner');
    await user.type(screen.getByLabelText('显示名称'), '新所有者');
    await user.type(screen.getByLabelText('密码（12–128 位）'), 'long-enough-password');
    await user.click(screen.getByRole('button', { name: '创建组织所有者' }));

    expect(await screen.findByText('组织所有者已创建')).toBeTruthy();
    expect(screen.getByLabelText('用户名')).toHaveProperty('value', 'new-owner');
  });
});
