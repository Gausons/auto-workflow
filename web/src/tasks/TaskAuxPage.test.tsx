import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskAuxPage } from './TaskAuxPage.js';

const sessionId = 'a'.repeat(64);
const snapshot = {
  tasks: [{ id: 'task-1', title: '修复登录', revision: 7, status: 'ready', sessionIds: [] }],
  sessions: [{ id: sessionId, title: '<script>不可信标题</script>', agent: 'codex', agentLabel: 'Codex', deviceId: 'local', cwd: '/repo', updatedAt: '2026-09-27T00:00:00.000Z' }],
  devices: [{ id: 'local', name: '测试设备', online: true, agents: ['codex'], transport: 'manual' }],
  handoffs: [], executions: []
};

function setup(route: '#inbox' | '#devices', permissions: string[], postStatus = 200) {
  location.hash = route;
  sessionStorage.setItem('bugflow.sessionToken', 'test-token');
  const fetchMock = vi.fn().mockImplementation((_path: string, init?: RequestInit) => Promise.resolve(new Response(JSON.stringify(init?.method === 'POST'
    ? postStatus === 200 ? { taskId: 'task-1' } : { message: '任务版本已变化' }
    : _path === '/api/bootstrap' ? { permissions }
      : _path.startsWith('/api/agent-sessions/') ? { messages: [{ role: 'user', text: '<img src=x onerror=alert(1)>' }], total: 1, session: {} }
        : snapshot), { status: init?.method === 'POST' ? postStatus : 200 })));
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><TaskAuxPage /></QueryClientProvider>);
  return fetchMock;
}

describe('TaskAuxPage', () => {
  afterEach(() => { cleanup(); sessionStorage.clear(); location.hash = ''; vi.unstubAllGlobals(); });

  it('renders untrusted session text literally and hides mutation actions from viewers', async () => {
    setup('#inbox', ['read']);
    expect(await screen.findByText('<script>不可信标题</script>')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.queryByRole('button', { name: '关联任务' })).toBeNull();
  });

  it('loads expanded session records without rendering active HTML', async () => {
    const fetchMock = setup('#inbox', ['read']);
    const title = await screen.findByText('<script>不可信标题</script>');
    expect(fetchMock.mock.calls.some(([path]) => String(path).startsWith('/api/agent-sessions/'))).toBe(false);
    await userEvent.setup().click(title);

    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('已显示 1 / 1 条记录')).toBeTruthy();
  });

  it('links one session using the selected task revision and opens the task', async () => {
    const fetchMock = setup('#inbox', ['read', 'work.execute']);
    const user = userEvent.setup();
    const opened = vi.fn();
    window.addEventListener('bugflow:open-task', opened, { once: true });
    await screen.findByText('<script>不可信标题</script>');
    await user.click(screen.getByRole('button', { name: '关联任务' }));
    await user.selectOptions(screen.getByLabelText('选择已有任务'), 'task-1');
    await user.click(within(screen.getByRole('form', { name: '关联会话' })).getByRole('button', { name: '关联任务' }));

    await waitFor(() => expect(opened).toHaveBeenCalledOnce());
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual({ action: 'link', taskId: 'task-1', revision: 7, sessionId });
  });

  it('routes from a session into new-task without creating a task prematurely', async () => {
    const fetchMock = setup('#inbox', ['read', 'work.execute']);
    const created = vi.fn();
    window.addEventListener('bugflow:create-task-from-session', created, { once: true });
    await screen.findByText('<script>不可信标题</script>');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '关联任务' }));
    await user.click(screen.getByRole('button', { name: '用此会话创建任务' }));

    expect((created.mock.calls[0]?.[0] as CustomEvent).detail.sessionId).toBe(sessionId);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('keeps a revision conflict visible and does not retry the link command', async () => {
    const fetchMock = setup('#inbox', ['read', 'work.execute'], 409);
    const user = userEvent.setup();
    await screen.findByText('<script>不可信标题</script>');
    await user.click(screen.getByRole('button', { name: '关联任务' }));
    await user.selectOptions(screen.getByLabelText('选择已有任务'), 'task-1');
    await user.click(within(screen.getByRole('form', { name: '关联会话' })).getByRole('button', { name: '关联任务' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '任务版本已变化');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('shows device status from the snapshot', async () => {
    setup('#devices', ['read']);
    expect(await screen.findByText('测试设备')).toBeTruthy();
    expect(screen.getByText('在线')).toBeTruthy();
    expect(screen.getByText('pnpm device:sync')).toBeTruthy();
  });
});
