import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevicesPage } from './DevicesPage.js';

const snapshot = {
  tasks: [], sessions: [], handoffs: [], executions: [],
  devices: [
    { id: 'local', name: '测试设备', online: true, agents: ['codex'], transport: 'manual' },
    { id: 'remote device', name: '远端开发机', online: false, agents: ['codex'], transport: 'connector', capabilities: { resumeCodex: true }, codexProjects: [{ id: 'project', name: '远端项目', cwd: '/remote/repo' }] }
  ]
};

function setup(permissions: string[], failSnapshot = false) {
  sessionStorage.setItem('bugflow.sessionToken', 'test-token');
  let failed = false;
  const fetchMock = vi.fn().mockImplementation((path: string) => {
    const failure = failSnapshot && !failed && path === '/api/task-center';
    if (failure) failed = true;
    return Promise.resolve(new Response(JSON.stringify(failure ? { message: '设备读取失败' } : path === '/api/bootstrap' ? { permissions } : snapshot), { status: failure ? 503 : 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DevicesPage /></QueryClientProvider>);
  return fetchMock;
}

describe('DevicesPage', () => {
  afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

  it('generates connection configuration without exposing the browser token', async () => {
    setup(['read', 'work.execute']);
    const config = await screen.findByLabelText('设备连接配置');
    expect((config as HTMLTextAreaElement).value.split('\n')).toHaveLength(3);
    expect((config as HTMLTextAreaElement).value).toContain('WORKBENCH_USERNAME=');
    expect((config as HTMLTextAreaElement).value).not.toContain('WORKBENCH_EXECUTE_CODEX');
    expect((config as HTMLTextAreaElement).value).not.toContain('WORKBENCH_TENANT');
    expect((config as HTMLTextAreaElement).value).not.toContain('test-token');
    expect(screen.getByText('npm install -g agent-workbench-connector')).toBeTruthy();
    expect(screen.getByText('agent-workbench-connector --env-file ./agent.env')).toBeTruthy();
  });

  it('shows device status from the snapshot', async () => {
    setup(['read']);
    expect(await screen.findByText('测试设备')).toBeTruthy();
    expect(screen.getByText('在线')).toBeTruthy();
    expect(screen.getByText('当前账号没有接入设备和远程执行任务的权限。')).toBeTruthy();
    expect(screen.queryByLabelText('设备连接配置')).toBeNull();
    expect(screen.queryByRole('link', { name: '新建远端任务' })).toBeNull();
  });

  it('stands alone and preserves the remote task target', async () => {
    setup(['read', 'work.execute']);
    await screen.findByLabelText('设备连接配置');
    expect(screen.getByRole('heading', { name: '设备与 Agent' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '任务中心视图' })).toBeNull();
    expect(screen.queryByRole('link', { name: /全部任务|未归属会话/ })).toBeNull();
    expect(screen.getByRole('link', { name: '新建远端任务' }).getAttribute('href')).toBe('/tasks/new?deviceId=remote%20device');
    expect(screen.getByText('远端项目 · /remote/repo')).toBeTruthy();
    expect(screen.getByText(/设备离线，已提交的任务/)).toBeTruthy();
  });

  it('retries a failed read and refreshes the device snapshot', async () => {
    const fetchMock = setup(['read'], true);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '加载失败：设备读取失败 重试');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('测试设备');
    await user.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => path === '/api/task-center')).toHaveLength(3));
  });
});
