import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssignmentPanel, ConfigPanel } from './SettingsPanels.js';

const bootstrap = (permissions: string[]) => ({
  config: { intervalMinutes: 15, openaiTimeoutMs: 30000, aiAssignmentModel: 'gpt-5.4-mini', enableAIAssignment: true, issueSourceLabel: 'Jira', issueSourceConfigured: true },
  scheduler: { enabled: false },
  assignmentPeople: [{ name: '小李', employeeId: '42', responsibility: '前端' }],
  permissions
});

function renderPanel(panel: React.ReactElement, route: string) {
  location.hash = route;
  sessionStorage.setItem('bugflow.sessionToken', 'test-token');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}>{panel}</QueryClientProvider>);
}

describe('settings panels', () => {
  afterEach(() => { cleanup(); sessionStorage.clear(); location.hash = ''; vi.unstubAllGlobals(); });

  it('sends explicit false checkbox values when saving configuration', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(bootstrap(['config.manage'])), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel(<ConfigPanel />, '#settings/config');
    const user = userEvent.setup();

    await screen.findByRole('button', { name: '保存配置' });
    await user.click(screen.getByLabelText('开启 AI 分配建议'));
    await user.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body.enableAIAssignment).toBe(false);
    expect(body.intervalMinutes).toBe(15);
    expect(body.openaiTimeoutMs).toBe(30000);
  });

  it('uses only a select for assignees and submits selection and clearing', async () => {
    const data = { ...bootstrap(['config.manage']), config: { ...bootstrap([]).config, assignee: '001' } };
    const fetchMock = vi.fn().mockImplementation((_path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') Object.assign(data.config, JSON.parse(String(init.body)));
      return Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPanel(<ConfigPanel />, '#settings/config');
    const user = userEvent.setup();
    const select = await screen.findByRole('combobox', { name: '扩展数据源经办人' });
    expect((select as HTMLSelectElement).value).toBe('001');
    expect(screen.queryByRole('textbox', { name: '扩展数据源经办人' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await screen.findByText('配置已保存');
    expect(data.config.assignee).toBe('001');
    await user.selectOptions(screen.getByRole('combobox', { name: '扩展数据源经办人' }), '42');
    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(data.config.assignee).toBe('42'));
    await screen.findByText('配置已保存');
    await user.selectOptions(screen.getByRole('combobox', { name: '扩展数据源经办人' }), '');
    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(data.config.assignee).toBe(''));
  });

  it('does not invent defaults or submit a managed workspace', async () => {
    const data = { ...bootstrap(['config.manage']), assignmentPeople: [], config: { workspaceManaged: true, codexWorkspaceDir: '/managed/repo' } };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(data), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel(<ConfigPanel />, '#settings/config');
    const user = userEvent.setup();
    await screen.findByText('暂无候选人员，请先在“分配规则”中添加。');
    expect((screen.getByLabelText('轮询间隔（分钟）') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('AI 分配模型') as HTMLSelectElement).value).toBe('');
    await user.click(screen.getByText('高级配置'));
    expect((screen.getByLabelText('OpenAI 请求超时（ms）') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('textbox', { name: 'IDE 执行路径' })).toBeNull();
    expect(screen.getByText('/managed/repo')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    for (const key of ['intervalMinutes', 'openaiTimeoutMs', 'aiAssignmentModel', 'codexWorkspaceDir']) expect(body).not.toHaveProperty(key);
    expect(body.assignee).toBe('');
  });

  it('preserves edits when switching the scheduler and reports save failures without retrying', async () => {
    const data = bootstrap(['config.manage']);
    const fetchMock = vi.fn().mockImplementation((path: string) => Promise.resolve(path === '/api/config'
      ? new Response(JSON.stringify({ message: '保存失败，请重试' }), { status: 500 })
      : new Response(JSON.stringify(path === '/api/scheduler' ? { ...data, scheduler: { enabled: true } } : data), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel(<ConfigPanel />, '#settings/config');
    const user = userEvent.setup();
    const interval = await screen.findByLabelText('轮询间隔（分钟）');
    await user.clear(interval);
    await user.type(interval, '45');
    await user.click(screen.getByRole('button', { name: '开启定时' }));
    await screen.findByRole('button', { name: '关闭定时' });
    expect((interval as HTMLInputElement).value).toBe('45');
    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await screen.findByText('保存失败，请重试');
    expect((interval as HTMLInputElement).value).toBe('45');
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/config')).toHaveLength(1);
  });

  it('loads configuration through the legacy #config address', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(bootstrap(['config.manage'])), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel(<ConfigPanel />, '#config');

    expect(await screen.findByRole('button', { name: '保存配置' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('replaces the saved assignment list once and renders the server result', async () => {
    const fetchMock = vi.fn().mockImplementation((_path: string, init?: RequestInit) => Promise.resolve(new Response(JSON.stringify(init?.method === 'PUT'
      ? { ...bootstrap(['people.manage']), assignmentPeople: [] }
      : bootstrap(['people.manage'])), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel(<AssignmentPanel />, '#settings/assignment');
    const user = userEvent.setup();

    await screen.findByDisplayValue('小李');
    await user.click(screen.getByRole('button', { name: '删除' }));

    expect(await screen.findByText('尚未配置人员。')).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ people: [] });
  });
});
