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
