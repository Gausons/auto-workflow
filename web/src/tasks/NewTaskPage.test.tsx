import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewTaskPage } from './NewTaskPage.js';

const sessionId = 'a'.repeat(64);
const snapshot = { tasks: [], sessions: [{ id: sessionId, title: '来源会话', deviceId: 'local' }], devices: [], handoffs: [], executions: [] };
const targets = { projects: [{ id: 'project-1', deviceId: 'local', deviceName: '本机', name: 'Codex', cwd: '/repo', online: true, defaultModel: 'model-1', models: [{ id: 'model-1', name: '模型一', defaultReasoningEffort: 'low', reasoningEfforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }] }, { id: 'gpt-6-sol', name: 'GPT-6-Sol', defaultReasoningEffort: 'low', reasoningEfforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }] }] }] };

function setup(permissions = ['work.execute'], failExecute = false, remote = false) {
  location.hash = '#new-task';
  sessionStorage.setItem('bugflow.sessionToken', 'test-token');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const completeGit = (id: string) => client.setQueryData(['task-center', 'snapshot'], { ...snapshot, gitRequests: [{ id, status: 'completed' }] });
  const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const status = path === '/api/task-center/execute' && failExecute ? 500 : 200;
    if (path === '/api/task-center/git' && remote && body.action !== 'create') queueMicrotask(() => completeGit(body.requestId));
    const payload = path === '/api/bootstrap' ? { permissions }
      : path === '/api/task-center/codex' ? remote ? { projects: [{ ...targets.projects[0], deviceId: 'remote', deviceName: '开发机', gitBranches: true }] } : targets
        : path.startsWith('/api/task-center/git?') ? { status: 'completed', result: { repository: true, current: 'remote/main', changes: 0, branches: ['remote/main'] } }
        : path === '/api/task-center/git' && remote ? { id: body.requestId, status: 'pending' }
        : path === '/api/task-center/git' ? { repository: true, current: body.cwd === '/repo/work' ? 'feature/work' : 'main', changes: 0, branches: ['main', 'feature/work'] }
        : path === '/api/task-center' && init?.method !== 'POST' ? snapshot
          : path === '/api/task-center' && body.action === 'create' ? { taskId: 'task-1', revision: 1 }
            : path === '/api/task-center/execute' && failExecute ? { message: 'Agent 未启动' } : {};
    return Promise.resolve(new Response(JSON.stringify(payload), { status }));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<QueryClientProvider client={client}><NewTaskPage /></QueryClientProvider>);
  return Object.assign(fetchMock, { completeGit });
}

describe('NewTaskPage', () => {
  afterEach(() => { cleanup(); sessionStorage.clear(); location.hash = ''; vi.unstubAllGlobals(); });

  it('denies viewers a create action', async () => {
    const fetchMock = setup(['read']);
    expect(await screen.findByText('当前账号没有创建任务权限。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建并发送任务' })).toHaveProperty('disabled', true);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('shows the current branch before opening the menu and refreshes it when the directory changes', async () => {
    const fetchMock = setup();
    const user = userEvent.setup();
    expect(await screen.findByText('main')).toBeTruthy();
    await user.click(screen.getByLabelText('工作目录：/repo'));
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/repo/work' } });
    expect(await screen.findByText('feature/work')).toBeTruthy();
    const lists = fetchMock.mock.calls.filter(([path]) => path === '/api/task-center/git').map(([, init]) => JSON.parse(String(init?.body)));
    expect(lists).toContainEqual({ action: 'list', projectId: 'project-1', deviceId: 'local', cwd: '' });
    expect(lists).toContainEqual({ action: 'list', projectId: 'project-1', deviceId: 'local', cwd: '/repo/work' });
  });

  it('shows remote branches and sends create operations to the selected device', async () => {
    const fetchMock = setup(['work.execute'], false, true);
    const user = userEvent.setup();
    await screen.findByText('remote/main', {}, { timeout: 4000 });
    await user.click(screen.getByLabelText('Git 分支'));
    await screen.findByLabelText('新分支名称', {}, { timeout: 4000 });
    await user.type(screen.getByLabelText('新分支名称'), 'feature/remote');
    await user.click(screen.getByRole('button', { name: '创建并切换' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/task-center/git' && JSON.parse(String(init?.body)).action === 'create')).toBe(true));
    const create = fetchMock.mock.calls.find(([url, init]) => url === '/api/task-center/git' && JSON.parse(String(init?.body)).action === 'create');
    expect(JSON.parse(String(create?.[1]?.body))).toMatchObject({ deviceId: 'remote', projectId: 'project-1', branch: 'feature/remote' });
    expect(screen.getByLabelText('执行位置')).toHaveProperty('disabled', true);
    fetchMock.completeGit(JSON.parse(String(create?.[1]?.body)).requestId);
    await waitFor(() => expect(screen.queryByText('正在处理分支…')).toBeNull(), { timeout: 4000 });
  });

  it('creates once and executes with selected target, directory, model and effort', async () => {
    const fetchMock = setup();
    const user = userEvent.setup();
    await screen.findByRole('option', { name: /Codex/ });
    await user.type(screen.getByLabelText('任务描述'), '修复登录');
    await user.click(screen.getByLabelText('工作目录：/repo'));
    await user.type(screen.getByLabelText('工作目录'), '/repo/work');
    await user.click(screen.getByLabelText('模型与思考强度'));
    await user.selectOptions(screen.getByLabelText('模型'), 'gpt-6-sol');
    fireEvent.change(screen.getByRole('slider', { name: '思考强度' }), { target: { value: '1' } });
    await user.click(screen.getByRole('button', { name: '创建并发送任务' }));

    const writesForTask = () => fetchMock.mock.calls.filter(([path, init]) => init?.method === 'POST' && ['/api/task-center', '/api/task-center/execute'].includes(path));
    await waitFor(() => expect(writesForTask()).toHaveLength(2));
    const writes = writesForTask().map(([, init]) => JSON.parse(String(init.body)));
    expect(writes[0]).toEqual({ action: 'create', content: '修复登录', sessionId: null });
    expect(writes[1]).toMatchObject({ taskId: 'task-1', revision: 1, projectId: 'project-1', deviceId: 'local', cwd: '/repo/work', model: 'gpt-6-sol', reasoningEffort: 'high' });
  });

  it('allows a reasoning effort with the default model', async () => {
    const fetchMock = setup();
    const user = userEvent.setup();
    await screen.findByRole('option', { name: /Codex/ });
    await user.type(screen.getByLabelText('任务描述'), '检查默认模型');
    await user.click(screen.getByLabelText('模型与思考强度'));
    const slider = screen.getByRole('slider', { name: '思考强度' });
    expect(slider).toHaveProperty('disabled', false);
    fireEvent.change(slider, { target: { value: '1' } });
    await user.click(screen.getByRole('button', { name: '创建并发送任务' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => path === '/api/task-center/execute')).toHaveLength(1));
    const execute = fetchMock.mock.calls.find(([path]) => path === '/api/task-center/execute');
    expect(JSON.parse(String(execute?.[1]?.body))).toMatchObject({ model: '', reasoningEffort: 'high' });
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
    expect(fetchMock.mock.calls.some(([path, init]) => init?.method === 'POST' && ['/api/task-center', '/api/task-center/execute'].includes(path))).toBe(false);
  });
});
