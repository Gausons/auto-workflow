import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryPage } from './HistoryPage.js';
import { createHistoryComposer } from '../../../public/historyComposer.js';

vi.mock('../../../public/historyComposer.js', () => ({
  createHistoryComposer: vi.fn(() => ({ mount: () => {}, unmount: () => {} }))
}));

const id = 'a'.repeat(64);
const session = { id, sessionId: id, agent: 'codex', agentLabel: 'Codex', deviceId: 'local', title: '<script>不可信标题</script>', cwd: '/repo/work', status: 'ready', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:01:00.000Z', messageCount: 1 };
const list = { offset: 0, limit: 30, total: 1, scope: 'workspace', providers: [{ id: 'codex', label: 'Codex', status: 'available' }], workspaces: [{ path: '/repo/work', count: 1 }], sessions: [session] };

function renderHistory(route = '#history') {
  location.hash = route;
  sessionStorage.setItem('bugflow.sessionToken', 'test-token');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><HistoryPage /></QueryClientProvider>);
}

describe('HistoryPage', () => {
  afterEach(() => { cleanup(); sessionStorage.clear(); location.hash = ''; vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('shows a safe session list and opens the existing hash address', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path.startsWith('/api/agent-sessions?') ? list : { permissions: ['read'] }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    renderHistory();

    const button = await screen.findByRole('button', { name: /不可信标题/ });
    expect(document.querySelector('script')).toBeNull();
    await userEvent.setup().click(button);
    expect(location.hash).toBe(`#history/${id}`);
  });

  it('renders transcript text safely and keeps the composer read-only for a viewer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path.startsWith('/api/agent-sessions?') ? list
      : path.startsWith(`/api/agent-sessions/${id}`) ? { session, messages: [{ role: 'user', text: '<img src=x onerror=alert(1)>' }], total: 1 }
        : { permissions: ['read'] }), { status: 200 }))));
    renderHistory(`#history/${id}`);

    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('只读')).toBeTruthy();
    expect(screen.getByText('已显示 1 / 1 条记录')).toBeTruthy();
  });

  it('sends the selected agent and search text to the history endpoint', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path.startsWith('/api/agent-sessions?') ? list : { permissions: ['read'] }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    renderHistory();
    const user = userEvent.setup();

    await screen.findByRole('button', { name: /不可信标题/ });
    await user.selectOptions(screen.getByLabelText('Agent'), 'codex');
    await user.type(screen.getByPlaceholderText('搜索会话…'), '回归');
    await user.click(screen.getByRole('button', { name: '刷新会话' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).includes('agent=codex') && String(path).includes('q=%E5%9B%9E%E5%BD%92'))).toBe(true));
  });

  it('refreshes the list even when search filters have not changed', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path.startsWith('/api/agent-sessions?') ? list : { permissions: ['read'] }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    renderHistory();

    await screen.findByRole('button', { name: /不可信标题/ });
    await userEvent.setup().click(screen.getByRole('button', { name: '刷新会话' }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => String(path).startsWith('/api/agent-sessions?'))).toHaveLength(2));
  });

  it('keeps one composer instance across history navigation so drafts can survive', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path.startsWith('/api/agent-sessions?') ? list
      : path.startsWith(`/api/agent-sessions/${id}`) ? { session, messages: [], total: 0 }
        : { permissions: ['read'] }), { status: 200 }))));
    renderHistory(`#history/${id}`);

    await screen.findByRole('heading', { name: '<script>不可信标题</script>' });
    location.hash = '#tasks';
    await waitFor(() => expect(screen.queryByRole('heading', { name: '<script>不可信标题</script>' })).toBeNull());
    location.hash = `#history/${id}`;
    await screen.findByRole('heading', { name: '<script>不可信标题</script>' });

    expect(createHistoryComposer).toHaveBeenCalledOnce();
  });
});
