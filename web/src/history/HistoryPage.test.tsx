import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryPage } from './HistoryPage.js';

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

  it.each([true, false])('labels remote excerpts without reporting corrupt records (has excerpt: %s)', async hasExcerpt => {
    const remote = { ...session, deviceId: 'remote', partial: true, recordMode: 'excerpt', messageCount: hasExcerpt ? 1 : 0 };
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path.startsWith('/api/agent-sessions?') ? { ...list, sessions: [remote] }
      : path.startsWith(`/api/agent-sessions/${id}`) ? { session: remote, messages: hasExcerpt ? [{ role: 'assistant', text: 'user: 问题\n\nassistant: 答复' }] : [], total: hasExcerpt ? 1 : 0 }
        : { permissions: ['read'] }), { status: 200 }))));
    renderHistory(`#history/${id}`);

    expect(await screen.findByText(hasExcerpt ? /来源连接器仍在同步旧版文本摘要/ : /尚未同步远程会话正文/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: hasExcerpt ? /仅同步摘要/ : /正文未同步/ })).toBeTruthy();
    expect(screen.getByText(hasExcerpt ? '已显示同步摘要 · 非完整历史' : '暂无同步摘要')).toBeTruthy();
    expect(screen.queryByText(/部分记录损坏/)).toBeNull();
    expect(screen.queryByText(/已显示 \d+ \/ \d+ 条记录/)).toBeNull();
    expect(screen.queryByRole('button', { name: /条记录/ })).toBeNull();
    if (hasExcerpt) expect(screen.getByText('查看旧版文本摘要').closest('details')).toHaveProperty('open', false);
  });

  it.each([
    { deviceId: 'local', canContinue: undefined, archived: false, allowed: true },
    { deviceId: 'remote', canContinue: true, archived: false, allowed: true },
    { deviceId: 'remote', canContinue: false, archived: false, allowed: false },
    { deviceId: 'remote', canContinue: true, archived: true, allowed: false }
  ])('uses the same continuation capability for the header and composer: %j', async capability => {
    const selected = { ...session, ...capability };
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path.startsWith('/api/agent-sessions?') ? { ...list, sessions: [selected] }
      : path.endsWith('/continue') ? { execution: null, executions: [] }
        : path.startsWith(`/api/agent-sessions/${id}`) ? { session: selected, messages: [], total: 0 }
          : path === '/api/task-center/codex' ? { projects: [] }
            : { permissions: ['work.execute'] }), { status: 200 }))));
    renderHistory(`#history/${id}`);

    expect(await screen.findByText(capability.allowed ? '可续聊' : '只读')).toBeTruthy();
    await userEvent.setup().type(screen.getByRole('textbox', { name: '发送消息' }), '继续检查');
    expect(screen.getByRole('button', { name: '发送消息' })).toHaveProperty('disabled', !capability.allowed);
    await userEvent.setup().clear(screen.getByRole('textbox', { name: '发送消息' }));
  });

  it.each(['local', 'remote'])('keeps partial record warnings for actual transcripts on %s devices', async deviceId => {
    const partial = { ...session, deviceId, source: 'conversation', managed: true, partial: true };
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path.startsWith('/api/agent-sessions?') ? { ...list, sessions: [partial] }
      : path.startsWith(`/api/agent-sessions/${id}`) ? { session: partial, messages: [{ role: 'user', text: '可用的原始消息' }], total: 1 }
        : { permissions: ['read'] }), { status: 200 }))));
    renderHistory(`#history/${id}`);

    expect(await screen.findByText(/部分记录损坏/)).toBeTruthy();
    expect(screen.getByText('已显示 1 / 1 条记录')).toBeTruthy();
    expect(await screen.findByRole('button', { name: /1 条记录.*部分记录/ })).toBeTruthy();
    expect(screen.queryByText(/当前仅展示远程设备同步的文本摘要/)).toBeNull();
  });

  it.each(['local', 'remote'])('renders user, assistant, tools and images with the same transcript UI on %s', async deviceId => {
    const selected = { ...session, deviceId, partial: deviceId === 'remote', recordMode: deviceId === 'remote' ? 'synced' : undefined, syncedRange: { offset: 10, total: 14, sourcePartial: false, truncated: false }, messageCount: 14 };
    const messages = [
      { role: 'user', text: '<script>查看截图</script>', images: [{ dataUrl: 'data:image/png;base64,aGVsbG8=', alt: '截图' }] },
      { role: 'tool_call', name: 'read_file', text: '读取源码', callId: 'call' },
      { role: 'tool_result', text: '工具输出', callId: 'call' },
      { role: 'assistant', text: '**检查完成**' }
    ];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path.startsWith('/api/agent-sessions?') ? { ...list, sessions: [selected] }
      : path.startsWith(`/api/agent-sessions/${id}`) ? { session: selected, messages, total: messages.length }
        : { permissions: ['read'] }), { status: 200 }))));
    renderHistory(`#history/${id}`);
    expect(await screen.findByText('<script>查看截图</script>')).toBeTruthy();
    expect(screen.getByRole('img', { name: '截图' })).toBeTruthy();
    expect(screen.getByText('使用了 1 次工具')).toBeTruthy();
    expect(screen.getByText('检查完成').tagName).toBe('STRONG');
    expect(document.querySelector('script')).toBeNull();
    expect(screen.queryByText(/部分记录损坏/)).toBeNull();
    if (deviceId === 'remote') expect(screen.getByText(/已同步第 11–14 条，共 14 条记录/)).toBeTruthy();
  });

  it('refreshes the list even when search filters have not changed', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path.startsWith('/api/agent-sessions?') ? list : { permissions: ['read'] }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    renderHistory();

    await screen.findByRole('button', { name: /不可信标题/ });
    await userEvent.setup().click(screen.getByRole('button', { name: '刷新会话' }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => String(path).startsWith('/api/agent-sessions?'))).toHaveLength(2));
  });

  it('refreshes the open transcript after the connector upgrades from excerpts to structured messages', async () => {
    let upgraded = false;
    const remote = { ...session, deviceId: 'remote', partial: true, recordMode: 'excerpt' };
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path.startsWith('/api/agent-sessions?') ? { ...list, sessions: [remote] }
      : path.startsWith(`/api/agent-sessions/${id}`) ? upgraded
        ? { session: { ...remote, recordMode: 'synced', syncedRange: { offset: 0, total: 2, sourcePartial: false, truncated: false } }, messages: [{ role: 'user', text: '同步后的问题' }, { role: 'assistant', text: '同步后的回复' }], total: 2 }
        : { session: remote, messages: [{ role: 'assistant', text: 'user: 旧摘要' }], total: 1 }
        : { permissions: ['read'] }), { status: 200 }))));
    renderHistory(`#history/${id}`);
    await screen.findByText('查看旧版文本摘要');
    upgraded = true;
    await userEvent.setup().click(screen.getByRole('button', { name: '刷新会话' }));
    expect(await screen.findByText('同步后的问题')).toBeTruthy();
    expect(screen.getByText('同步后的回复')).toBeTruthy();
    expect(screen.queryByText('查看旧版文本摘要')).toBeNull();
  });

  it('preserves a React composer draft across history navigation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path.startsWith('/api/agent-sessions?') ? list
      : path.startsWith(`/api/agent-sessions/${id}`) ? { session, messages: [], total: 0 }
        : path === '/api/task-center/codex' ? { projects: [] }
          : { permissions: ['work.execute'] }), { status: 200 }))));
    renderHistory(`#history/${id}`);

    await screen.findByRole('heading', { name: '<script>不可信标题</script>' });
    await userEvent.setup().type(screen.getByRole('textbox', { name: '发送消息' }), '保留这段草稿');
    location.hash = '#tasks';
    await waitFor(() => expect(screen.queryByRole('heading', { name: '<script>不可信标题</script>' })).toBeNull());
    location.hash = `#history/${id}`;
    await screen.findByRole('heading', { name: '<script>不可信标题</script>' });

    expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveProperty('value', '保留这段草稿');
  });
});
