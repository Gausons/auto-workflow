import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevicesPage } from './DevicesPage.js';

const snapshot = {
  tasks: [], sessions: [], handoffs: [], executions: [],
  devices: [
    { id: 'local', name: '测试设备', online: true, agents: [], transport: 'manual', historySources: [{ id: 'codex', label: 'Codex', status: 'unconfigured', sessionCount: 0, skipped: 0 }, { id: 'claude', label: 'Claude Code', status: 'missing', sessionCount: 0, skipped: 0 }] },
    { id: 'remote device', name: '远端开发机', owner: 'owner', online: false, agents: ['codex'], transport: 'connector', capabilities: { resumeCodex: true }, codexProjects: [{ id: 'project', name: '远端项目', cwd: '/remote/repo' }] }
  ]
};

function setup(permissions: string[], failSnapshot = false, execution: unknown = { projects: [], localError: '未找到 Codex 可执行文件' }, data: unknown = snapshot) {
  sessionStorage.setItem('bugflow.sessionToken', 'test-token');
  let failed = false;
  let currentData = structuredClone(data);
  const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/api/auth/device-deployment') return Promise.resolve(new Response(JSON.stringify({ deploymentToken: 'd'.repeat(43), expiresAt: Date.now() + 600_000 }), { status: 201 }));
    if (init?.method === 'POST') {
      const command = JSON.parse(String(init.body));
      const state = currentData as typeof snapshot;
      currentData = { ...state, devices: state.devices.map(device => device.id === command.deviceId ? { ...device, cardHidden: command.action === 'remove-device-card' } : device) };
    }
    const failure = failSnapshot && !failed && path === '/api/task-center';
    if (failure) failed = true;
    return Promise.resolve(new Response(JSON.stringify(failure ? { message: '设备读取失败' } : path === '/api/bootstrap' ? { permissions, user: { id: 'owner', username: 'owner' } } : path === '/api/task-center/codex' ? execution : currentData), { status: failure ? 503 : 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DevicesPage /></QueryClientProvider>);
  return fetchMock;
}

describe('DevicesPage', () => {
  afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

  it('generates a single-use deployment command without exposing the browser token', async () => {
    const fetchMock = setup(['read', 'work.execute']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '连接设备' }));
    expect(screen.getByText(/设备上线后自动转入后台，可关闭终端/)).toBeTruthy();
    expect(screen.queryByLabelText('一键部署命令')).toBeNull();
    await user.click(screen.getByRole('button', { name: '生成并复制部署命令' }));
    const command = (await screen.findByLabelText('一键部署命令') as HTMLTextAreaElement).value;
    expect(command).toMatch(/^npx --yes agent-workbench-connector@latest --connect [A-Za-z0-9_-]+$/);
    const config = JSON.parse(Buffer.from(command.split(' ').at(-1)!, 'base64url').toString('utf8'));
    expect(config.url).toBe(location.origin);
    expect(config.deploymentToken).toBe('d'.repeat(43));
    expect(config.username).toBeUndefined();
    expect(command).not.toContain('test-token');
    expect(await navigator.clipboard.readText()).toBe(command);
    expect(screen.getByRole('status').textContent).toContain('尚未部署');
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/auth/device-deployment')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '已复制，再次复制' }));
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/auth/device-deployment')).toHaveLength(1);
  });

  it('offers manual copying when clipboard permission is denied', async () => {
    setup(['work.execute']);
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    await user.click(await screen.findByRole('button', { name: '连接设备' }));
    await user.click(screen.getByRole('button', { name: '生成并复制部署命令' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '自动复制失败，请点击“复制部署命令”或选中上方命令手动复制。');
    await user.click(screen.getByRole('button', { name: '复制部署命令' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not retry uncertain issuance and lets the user explicitly regenerate', async () => {
    const fetchMock = setup(['work.execute']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '连接设备' }));
    fetchMock.mockRejectedValueOnce(new Error('网络失败'));
    await user.click(screen.getByRole('button', { name: '生成并复制部署命令' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '生成失败：网络失败。请重试；此前的命令可能已失效。');
    expect(screen.queryByLabelText('一键部署命令')).toBeNull();
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/auth/device-deployment')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '生成并复制部署命令' }));
    expect(await screen.findByLabelText('一键部署命令')).toBeTruthy();
  });

  it('hides expired deployment commands', async () => {
    const fetchMock = setup(['work.execute']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '连接设备' }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ deploymentToken: 'd'.repeat(43), expiresAt: Date.now() - 1 })));
    await user.click(screen.getByRole('button', { name: '生成并复制部署命令' }));
    expect(await screen.findByText('部署命令已过期，请重新生成。')).toBeTruthy();
    expect(screen.queryByLabelText('一键部署命令')).toBeNull();
  });

  it('shows device status from the snapshot', async () => {
    const fetchMock = setup(['read']);
    expect(await screen.findByText('测试设备')).toBeTruthy();
    expect(screen.getByText('在线')).toBeTruthy();
    expect(screen.getByText('离线')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/task-center/codex')).toBe(false);
    expect(screen.queryByRole('button', { name: /删除 .* 卡片/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '连接设备' })).toBeNull();
    expect(screen.queryByLabelText('设备连接配置')).toBeNull();
    expect(screen.queryByRole('link', { name: '新建远端任务' })).toBeNull();
  });

  it('stands alone and preserves the remote task target', async () => {
    setup(['read', 'work.execute']);
    await screen.findByText('远端开发机');
    expect(screen.getByRole('heading', { name: '设备与 Agent' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '任务中心视图' })).toBeNull();
    expect(screen.queryByLabelText('设备连接配置')).toBeNull();
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
    expect(screen.queryByRole('link', { name: '新建本地任务' })).toBeNull();
  });

  it.each(['read', 'work.execute'])('shows service-only mode without probing local execution for %s', async permission => {
    const fetchMock = setup([permission], false, { projects: [], localExecutionEnabled: false }, { ...snapshot, devices: [{ ...snapshot.devices[0], localExecutionEnabled: false }] });
    expect(await screen.findByText('还没有设备卡片')).toBeTruthy();
    expect(screen.queryByText('测试设备')).toBeNull();
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

  it('cancels, removes and restores a card without removing the device from other views', async () => {
    const fetchMock = setup(['work.execute']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '删除 远端开发机 卡片' }));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(fetchMock.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false);
    await user.click(screen.getByRole('button', { name: '删除 远端开发机 卡片' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: '远端开发机' })).toBeNull());
    await user.click(screen.getByText('已删除的卡片 · 1'));
    await user.click(screen.getByRole('button', { name: '恢复 远端开发机' }));
    expect(await screen.findByRole('article', { name: '远端开发机' })).toBeTruthy();
  });

  it('retains a card on failure and allows an explicit retry', async () => {
    const fetchMock = setup(['work.execute']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '删除 远端开发机 卡片' }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: '保存失败' }), { status: 503 }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '操作失败：保存失败');
    expect(screen.getByRole('article', { name: '远端开发机' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: '远端开发机' })).toBeNull());
  });

  it('does not offer removal of another account’s device', async () => {
    setup(['work.execute'], false, { projects: [] }, { ...snapshot, devices: [{ ...snapshot.devices[1], owner: 'another-user' }] });
    await screen.findByText('远端开发机');
    expect(screen.queryByRole('button', { name: /删除 .* 卡片/ })).toBeNull();
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
