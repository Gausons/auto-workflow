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
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ token: 'member-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
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
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path === '/api/auth/providers' ? { google: false } : { message: '用户名或密码错误' }), { status: path === '/api/auth/providers' ? 200 : 401, headers: { 'Content-Type': 'application/json' } }))));
    renderAuth();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('用户名或密码错误')).toBeTruthy();
    expect(sessionStorage.getItem('bugflow.sessionToken')).toBeNull();
  });

  it('keeps personal registration available and stores its session', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path === '/api/auth/providers' ? { google: false, registration: false } : { token: 'registered-token' }), { status: path === '/api/auth/providers' ? 200 : 201, headers: { 'Content-Type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);
    const reload = renderAuth();
    const user = userEvent.setup();

    await user.click(await screen.findByText('首次使用？注册个人账号'));
    await user.type(screen.getByLabelText('用户名（推荐使用邮箱）'), 'new-owner');
    await user.type(screen.getByLabelText('显示名称'), '新所有者');
    await user.type(screen.getByLabelText('密码（12–128 位）'), 'long-enough-password');
    await user.click(screen.getByRole('button', { name: '注册并进入' }));

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(sessionStorage.getItem('bugflow.sessionToken')).toBe('registered-token');
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/register', expect.objectContaining({ method: 'POST' }));
  });

  it('shows Google SSO when configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ google: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    renderAuth();
    expect((await screen.findByRole('link', { name: '使用 Google 单点登录' })).getAttribute('href')).toBe('/api/auth/google/start');
    expect(screen.queryByText('Google 单点登录尚未配置')).toBeNull();
  });

  it('keeps Google SSO visible and explains when it is not configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ google: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    renderAuth();
    expect((await screen.findByRole('link', { name: '使用 Google 单点登录' })).getAttribute('href')).toBe('/api/auth/google/start');
    expect(await screen.findByText('Google 单点登录尚未配置')).toBeTruthy();
  });
});
