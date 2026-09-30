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

  it('formats source HTML and timestamps without trusting attributes or executable markup', async () => {
    const data = bootstrap(['read']);
    const bug = { ...data.bugs[0], updatedAt: '1790155034256', description: '<p onclick="alert(1)">环境：日常<br>第二行 <strong>重点</strong></p><p><img src="x" onerror="alert(1)"><script>alert(1)</script></p>' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...data, bugs: [bug] }))));
    renderWorkbench();
    expect(await screen.findByText('重点')).toHaveProperty('tagName', 'STRONG');
    expect(screen.getByText(/环境：日常/).querySelector('br')).toBeTruthy();
    expect(document.querySelector('[onclick], [onerror], script, img')).toBeNull();
    expect(screen.queryByText('1790155034256')).toBeNull();
    expect(screen.getByText(/2026\/09\/23/)).toBeTruthy();
  });

  it('searches by title, code and assignee, selects visible results and restores the list', async () => {
    const data = bootstrap(['read']);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...data, bugs: [...data.bugs, { id: 'BUG-2', title: '导出报表失败', assignee: '张三' }] }))));
    renderWorkbench();
    await screen.findByRole('heading', { name: '登录失败' });
    const user = userEvent.setup();
    const search = screen.getByRole('searchbox', { name: '搜索缺陷' });
    for (const keyword of ['报表', 'bug-2', '张三']) {
      await user.clear(search);
      await user.type(search, keyword);
      expect(screen.getByRole('heading', { name: '导出报表失败' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /BUG-1/ })).toBeNull();
    }
    await user.clear(search);
    await user.type(search, '不存在');
    expect(screen.getByText('没有匹配的缺陷，试试其他关键词。')).toBeTruthy();
    await user.clear(search);
    expect(screen.getByRole('button', { name: /BUG-1/ })).toBeTruthy();
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
