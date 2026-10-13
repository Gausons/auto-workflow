import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevicesPage } from './DevicesPage.js';

const snapshot = {
  tasks: [], sessions: [], handoffs: [], executions: [],
  devices: [
    { id: 'local', name: '测试设备', online: true, agents: [], transport: 'manual', historySources: [{ id: 'codex', label: 'Codex', status: 'unconfigured', sessionCount: 0, skipped: 0 }, { id: 'claude', label: 'Claude Code', status: 'missing', sessionCount: 0, skipped: 0 }] },
    { id: 'remote device', name: '远端开发机', online: false, agents: ['codex'], transport: 'connector', capabilities: { resumeCodex: true }, codexProjects: [{ id: 'project', name: '远端项目', cwd: '/remote/repo' }] }
  ]
};

function setup(permissions: string[], failSnapshot = false, execution: unknown = { projects: [], localError: '未找到 Codex 可执行文件' }, data: unknown = snapshot) {
  sessionStorage.setItem('bugflow.sessionToken', 'test-token');
  let failed = false;
  const fetchMock = vi.fn().mockImplementation((path: string) => {
    const failure = failSnapshot && !failed && path === '/api/task-center';
    if (failure) failed = true;
    return Promise.resolve(new Response(JSON.stringify(failure ? { message: '设备读取失败' } : path === '/api/bootstrap' ? { permissions } : path === '/api/task-center/codex' ? execution : data), { status: failure ? 503 : 200 }));
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
    const fetchMock = setup(['read']);
    expect(await screen.findByText('测试设备')).toBeTruthy();
    expect(screen.getByText('服务运行中')).toBeTruthy();
    expect(screen.queryByText('在线')).toBeNull();
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/task-center/codex')).toBe(false);
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

  it('distinguishes service availability, missing history and unavailable execution', async () => {
    setup(['read', 'work.execute']);
    expect(await screen.findByText('本地执行不可用：未找到 Codex 可执行文件')).toBeTruthy();
    expect(screen.getByText('当前账号可见会话：0 个')).toBeTruthy();
    expect(screen.getByText('Codex · 当前账号未配置历史来源 · 0 个历史会话')).toBeTruthy();
    expect(screen.getByText('Claude Code · 未找到历史目录 · 0 个历史会话')).toBeTruthy();
    expect(screen.getByText(/请在开发机运行下方连接器/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: '新建本地任务' })).toBeNull();
  });

  it.each(['read', 'work.execute'])('shows service-only mode without probing local execution for %s', async permission => {
    const fetchMock = setup([permission], false, { projects: [], localExecutionEnabled: false }, { ...snapshot, devices: [{ ...snapshot.devices[0], localExecutionEnabled: false }] });
    expect(await screen.findByText('仅运行工作台')).toBeTruthy();
    expect(screen.queryByText(/未找到历史目录|本地执行不可用|未配置历史来源/)).toBeNull();
    expect(screen.queryByRole('link', { name: '新建本地任务' })).toBeNull();
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/task-center/codex')).toBe(false);
  });

  it('shows local execution independently of whether historical sessions exist', async () => {
    setup(['work.execute'], false, { projects: [{ id: 'codex', deviceId: 'local', name: 'Codex', cwd: '/repo' }] });
    expect(await screen.findByText('可执行 Agent：Codex')).toBeTruthy();
    expect(screen.getByText('当前账号可见会话：0 个')).toBeTruthy();
    expect(screen.getByRole('link', { name: '新建本地任务' }).getAttribute('href')).toBe('/tasks/new?deviceId=local');
  });

  it('preserves visible history when there is no executable Agent', async () => {
    setup(['work.execute'], false, { projects: [] }, { ...snapshot, sessions: [{ id: 's1', deviceId: 'local' }, { id: 's2', deviceId: 'remote device' }, { id: 's3', deviceId: 'local', missing: true }], devices: [{ ...snapshot.devices[0], historySources: [{ id: 'codex', label: 'Codex', status: 'available', sessionCount: 1, skipped: 2 }] }] });
    expect(await screen.findByText('未发现可用的本地执行目标；历史记录可读取不代表 Agent 可执行。')).toBeTruthy();
    expect(screen.getByText('当前账号可见会话：1 个')).toBeTruthy();
    expect(screen.getByText('Codex · 历史目录可读取 · 1 个历史会话 · 2 项未能读取')).toBeTruthy();
    expect(screen.queryByText(/请在开发机运行下方连接器/)).toBeNull();
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
