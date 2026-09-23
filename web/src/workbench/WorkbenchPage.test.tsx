import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchPage } from './WorkbenchPage.js';

const bootstrap = (permissions: string[]) => ({
  bugs: [{ id: 'BUG-1', code: 'BUG-1', title: '登录失败', status: '待处理', description: '<script>不可信描述</script>' }],
  metrics: { total: 1, pending: 1, processing: 0, resolved: 0 },
  scheduler: { lastRunMessage: '同步完成' },
  permissions
});

function renderWorkbench() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  document.body.append(Object.assign(document.createElement('div'), { id: 'workbenchActions' }));
  location.hash = '#workbench';
  sessionStorage.setItem('bugflow.sessionToken', 'test-token');
  render(<QueryClientProvider client={client}><WorkbenchPage /></QueryClientProvider>);
}

describe('WorkbenchPage', () => {
  afterEach(() => {
    cleanup();
    document.querySelector('#workbenchActions')?.remove();
    sessionStorage.clear();
    location.hash = '';
    vi.unstubAllGlobals();
  });

  it('shows untrusted defect text literally and hides write actions for a viewer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(bootstrap(['read'])), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderWorkbench();

    expect(await screen.findByText('<script>不可信描述</script>')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.queryByRole('button', { name: '生成任务' })).toBeNull();
    expect(screen.getByRole('button', { name: '立即拉取' })).toHaveProperty('disabled', true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates one task and sends its id to the existing task center', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(path === '/api/bootstrap'
      ? bootstrap(['read', 'work.execute'])
      : { taskId: 'task-1', existing: false }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    renderWorkbench();
    const opened = vi.fn();
    window.addEventListener('bugflow:open-task', opened, { once: true });

    await screen.findByRole('heading', { name: '登录失败' });
    await userEvent.setup().click(screen.getByRole('button', { name: '生成任务' }));

    await waitFor(() => expect(opened).toHaveBeenCalledOnce());
    expect((opened.mock.calls[0]?.[0] as CustomEvent).detail.taskId).toBe('task-1');
    expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/task'))).toHaveLength(1);
  });

  it('shows a retryable failure instead of an empty defect list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: '暂时无法读取' }), { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    renderWorkbench();

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '加载失败：暂时无法读取 重试');
    expect(screen.queryByText('暂无缺陷，点击“立即拉取”。')).toBeNull();
  });
});
