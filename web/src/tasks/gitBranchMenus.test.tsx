import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewTaskPage } from './NewTaskPage.js';
import { HistoryComposer } from '../history/HistoryComposer.js';

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

const state = (current = 'main') => ({ repository: true, current, changes: 0, branches: ['main', 'feature/work'] });
let sessionIndex = 0;

function setup(page: 'task' | 'history', remote: boolean, initialPending = false) {
  location.hash = '#new-task';
  sessionStorage.setItem('bugflow.sessionToken', 'test-token');
  const initial = deferredResponse(), refresh = deferredResponse(), mutation = deferredResponse();
  const deviceId = remote ? 'remote' : 'local';
  const project = { id: 'p', deviceId, name: 'Codex', cwd: '/repo', online: true, gitBranches: true };
  const response = (current = 'main') => Response.json(remote ? { status: 'completed', result: state(current) } : state(current));
  let reads = 0;
  let refreshSignal: AbortSignal | null | undefined;
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/task-center/git') {
      const body = JSON.parse(String(init?.body)) as { action: string; cwd: string };
      if (body.action !== 'list') return mutation.promise;
      if (page === 'history' && !body.cwd) return Promise.resolve(response());
      if (++reads === 1) return initialPending ? initial.promise : Promise.resolve(response());
      refreshSignal = init?.signal;
      return refresh.promise;
    }
    return Promise.resolve(Response.json(url === '/api/task-center/codex' ? { projects: [project] }
      : url === '/api/bootstrap' ? { permissions: ['work.execute'] }
        : { tasks: [], sessions: [], devices: [], executions: [], handoffs: [] }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(<QueryClientProvider client={client}>{page === 'task' ? <NewTaskPage />
    : <HistoryComposer session={{ id: `branch-menu-${++sessionIndex}`, agent: 'codex', deviceId, cwd: '/repo', title: '测试会话', updatedAt: '' }} historyMessages={[]} canEdit syncHistory={async () => []} />}</QueryClientProvider>);
  return { initial, refresh, mutation, response, fetchMock, client, refreshSignal: () => refreshSignal };
}

afterEach(() => { cleanup(); sessionStorage.clear(); location.hash = ''; vi.unstubAllGlobals(); });

describe.each(['task', 'history'] as const)('%s branch menu', page => {
  async function openMode() {
    if (page === 'history') await userEvent.setup().click(screen.getByRole('button', { name: /带上下文新开会话/ }));
  }

  it.each([false, true])('allows switching during a slow refresh without accepting its stale result (remote=%s)', async remote => {
    const fixture = setup(page, remote);
    await openMode();
    await waitFor(() => expect(screen.getByLabelText('Git 分支').textContent).toContain('main'));
    await userEvent.setup().click(screen.getByLabelText('Git 分支'));
    await screen.findByText('正在刷新分支…');
    const branch = screen.getByRole('button', { name: 'feature/work' });
    expect(branch).toHaveProperty('disabled', false);
    await userEvent.setup().click(branch);
    await screen.findByText('正在切换分支…');
    expect(screen.getByLabelText('执行位置')).toHaveProperty('disabled', true);
    await waitFor(() => expect(fixture.refreshSignal()?.aborted).toBe(true));
    expect(fixture.fetchMock.mock.calls.filter(([url, init]) => url === '/api/task-center/git' && JSON.parse(String(init?.body)).action === 'switch')).toHaveLength(1);
    await act(async () => { fixture.mutation.resolve(fixture.response('feature/work')); });
    await waitFor(() => expect(screen.getByLabelText('Git 分支').textContent).toContain('feature/work'));
    await act(async () => { fixture.refresh.resolve(fixture.response()); });
    expect(screen.getByLabelText('Git 分支').textContent).toContain('feature/work');
    expect(screen.queryByText('正在切换分支…')).toBeNull();
    fixture.client.clear();
  });

  it('keeps cached options with an explicit warning when refreshing fails', async () => {
    const fixture = setup(page, true);
    await openMode();
    await waitFor(() => expect(screen.getByLabelText('Git 分支').textContent).toContain('main'));
    await userEvent.setup().click(screen.getByLabelText('Git 分支'));
    await screen.findByText('正在刷新分支…');
    await act(async () => { fixture.refresh.resolve(Response.json({ message: '连接器暂不可用' }, { status: 502 })); });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '分支刷新失败：连接器暂不可用；当前显示上次读取结果。');
    expect(screen.getByRole('button', { name: 'feature/work' })).toHaveProperty('disabled', false);
    fixture.client.clear();
  });

  it('shows a read-specific waiting state before the first branch response', async () => {
    const fixture = setup(page, true, true);
    await openMode();
    await userEvent.setup().click(await screen.findByLabelText('Git 分支'));
    expect(await screen.findByText('正在读取分支…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'feature/work' })).toBeNull();
    await act(async () => { fixture.initial.resolve(fixture.response()); });
    expect(await screen.findByRole('button', { name: 'feature/work' })).toBeTruthy();
    fixture.client.clear();
  });
});
