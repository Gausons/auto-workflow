import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskPage } from './TaskPage.js';

const task = { id: 'task-1', title: '<script>任务</script>', status: 'ready', revision: 7, contextVersion: 3, content: '修复登录', sessionIds: [], events: [], createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z' };
const snapshot = { tasks: [task], sessions: [], devices: [], handoffs: [], executions: [] };

function setup(permissions = ['work.execute'], data: unknown = snapshot, postStatus = 200) {
  location.hash = '#tasks';
  sessionStorage.setItem('bugflow.sessionToken', 'test-token');
  const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => Promise.resolve(new Response(JSON.stringify(init?.method === 'POST'
    ? postStatus === 200 ? {} : { message: '任务版本已变化' }
    : path === '/api/bootstrap' ? { permissions } : data), { status: init?.method === 'POST' ? postStatus : 200 })));
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><TaskPage /></QueryClientProvider>);
  return fetchMock;
}

describe('TaskPage', () => {
  afterEach(() => { cleanup(); sessionStorage.clear(); location.hash = ''; vi.unstubAllGlobals(); });

  it('renders untrusted title literally and removes mutation controls for a viewer', async () => {
    setup(['read']);
    expect(await screen.findByRole('heading', { name: '<script>任务</script>' })).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑任务' })).toBeNull();
    expect(screen.queryByRole('button', { name: '继续任务' })).toBeNull();
  });

  it('updates with the current revision and never retries a conflict', async () => {
    const fetchMock = setup(['work.execute'], snapshot, 409);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: '编辑任务' });
    await user.click(screen.getByRole('button', { name: '编辑任务' }));
    await user.clear(screen.getByLabelText('任务内容 · Markdown'));
    await user.type(screen.getByLabelText('任务内容 · Markdown'), '新内容');
    await user.click(screen.getByRole('button', { name: '保存任务' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '任务版本已变化');
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual({ action: 'update', taskId: 'task-1', revision: 7, content: '新内容', status: 'ready' });
  });

  it('keeps unknown executions visible for manual reconciliation instead of resubmission', async () => {
    const data = { ...snapshot, executions: [{ id: 'job-1', taskId: 'task-1', status: 'unknown', message: '状态不确定', contextVersion: 3, deviceId: 'local', cwd: '/repo', title: '任务', prompt: '修复', createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z' }] };
    const fetchMock = setup(['work.execute'], data);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: '核对执行结果' });
    expect(screen.queryByRole('button', { name: '继续任务' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '核对执行结果' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1));
    expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body))).toEqual({ executionId: 'job-1', action: 'reconcile' });
  });

  it('submits one explicit response to a waiting Agent request', async () => {
    const data = { ...snapshot, executions: [{ id: 'job-2', taskId: 'task-1', status: 'waiting', contextVersion: 3, deviceId: 'local', cwd: '/repo', title: '任务', prompt: '修复', createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z', request: { method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q1', question: '是否继续？' }] } } }] };
    const fetchMock = setup(['work.execute'], data);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: '处理待办' });
    await user.click(screen.getByRole('button', { name: '处理待办' }));
    await user.type(screen.getByLabelText('是否继续？'), '继续');
    await user.click(screen.getByRole('button', { name: '发送回复' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1));
    expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body))).toEqual({ executionId: 'job-2', action: 'respond', answers: { q1: '继续' } });
  });
});
