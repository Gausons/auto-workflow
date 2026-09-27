import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewTaskPage } from './NewTaskPage.js';

const sessionId = 'a'.repeat(64);
const snapshot = { tasks: [], sessions: [{ id: sessionId, title: '来源会话', deviceId: 'local' }], devices: [], handoffs: [], executions: [] };
const targets = { projects: [{ id: 'project-1', deviceId: 'local', deviceName: '本机', name: 'Codex', cwd: '/repo', online: true, models: [{ id: 'model-1', name: '模型一', reasoningEfforts: [{ id: 'high', name: '高' }] }] }] };

function setup(permissions = ['work.execute'], failExecute = false) {
  location.hash = '#new-task';
  sessionStorage.setItem('bugflow.sessionToken', 'test-token');
  const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const status = path === '/api/task-center/execute' && failExecute ? 500 : 200;
    const payload = path === '/api/bootstrap' ? { permissions }
      : path === '/api/task-center/codex' ? targets
        : path === '/api/task-center' && init?.method !== 'POST' ? snapshot
          : path === '/api/task-center' && body.action === 'create' ? { taskId: 'task-1', revision: 1 }
            : path === '/api/task-center/execute' && failExecute ? { message: 'Agent 未启动' } : {};
    return Promise.resolve(new Response(JSON.stringify(payload), { status }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><NewTaskPage /></QueryClientProvider>);
  return fetchMock;
}

describe('NewTaskPage', () => {
  afterEach(() => { cleanup(); sessionStorage.clear(); location.hash = ''; vi.unstubAllGlobals(); });

  it('denies viewers a create action', async () => {
    const fetchMock = setup(['read']);
    expect(await screen.findByText('当前账号没有创建任务权限。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建并发送任务' })).toHaveProperty('disabled', true);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('creates once and executes with selected target, directory, model and effort', async () => {
    const fetchMock = setup();
    const user = userEvent.setup();
    await screen.findByRole('option', { name: /Codex/ });
    await user.type(screen.getByLabelText('任务描述'), '修复登录');
    await user.click(screen.getByLabelText('工作目录：/repo'));
    await user.type(screen.getByLabelText('工作目录'), '/repo/work');
    await user.click(screen.getByLabelText('模型与思考强度'));
    await user.selectOptions(screen.getByLabelText('模型'), 'model-1');
    await user.selectOptions(screen.getByLabelText('思考强度'), 'high');
    await user.click(screen.getByRole('button', { name: '创建并发送任务' }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2));
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init.body)));
    expect(writes[0]).toEqual({ action: 'create', content: '修复登录', sessionId: null });
    expect(writes[1]).toMatchObject({ taskId: 'task-1', revision: 1, projectId: 'project-1', deviceId: 'local', cwd: '/repo/work', model: 'model-1', reasoningEffort: 'high' });
  });

  it('reports an execution failure without recreating the task', async () => {
    const fetchMock = setup(['work.execute'], true);
    const user = userEvent.setup();
    await screen.findByRole('option', { name: /Codex/ });
    await user.type(screen.getByLabelText('任务描述'), '修复登录');
    await user.click(screen.getByRole('button', { name: '创建并发送任务' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '任务已创建，但 Agent 启动失败：Agent 未启动');
    expect(fetchMock.mock.calls.filter(([path, init]) => path === '/api/task-center' && init?.method === 'POST')).toHaveLength(1);
  });

  it('prefills from a source session without executing until submit', async () => {
    const fetchMock = setup();
    await screen.findByRole('option', { name: /Codex/ });
    window.dispatchEvent(new CustomEvent('bugflow:create-task-from-session', { detail: { sessionId } }));
    expect(await screen.findByDisplayValue('来源会话')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});
