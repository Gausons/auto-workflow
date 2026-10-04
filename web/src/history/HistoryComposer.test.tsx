import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/taskTypes.js';
import { HistoryComposer } from './HistoryComposer.js';

const id = 'a'.repeat(64);
const session = { id, sessionId: id, agent: 'codex', deviceId: 'local', title: '测试会话', cwd: '/repo', updatedAt: '2026-09-27T00:00:00Z' } satisfies Session;
const projects = [{ id: 'project-1', deviceId: 'local', deviceName: '本机', name: 'Codex', agent: 'codex', cwd: '/repo', online: true, defaultModel: 'gpt-6-luna', models: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna', defaultReasoningEffort: 'medium', reasoningEfforts: [{ id: 'low', name: '低' }, { id: 'medium', name: '中' }, { id: 'high', name: '高' }] }, { id: 'gpt-6-sol', name: 'GPT-6-Sol', defaultReasoningEffort: 'medium', reasoningEfforts: [{ id: 'low', name: '低' }, { id: 'medium', name: '中' }, { id: 'high', name: '高' }] }] }];
let nextSession = 0;

function setup(status: unknown = { execution: null, executions: [] }, failSend = false, projects: unknown[] = [], selectedSession: Session = session, options: { canEdit?: boolean; failCreate?: boolean } = {}) {
  if (selectedSession === session) selectedSession = { ...session, id: (++nextSession).toString(16).padStart(64, '0') };
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  let failures = failSend ? 1 : 0;
  let createFailures = options.failCreate ? 1 : 0;
  const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      if (path.endsWith('/continue') && failures-- > 0) return Promise.resolve(new Response(JSON.stringify({ message: '网络暂不可用' }), { status: 503 }));
      if (path.endsWith('/continue-as-new') && createFailures-- > 0) return Promise.resolve(new Response(JSON.stringify({ message: '创建结果暂不可用' }), { status: 503 }));
      const result = path === '/api/task-center/git' ? { repository: true, current: 'main', changes: 0, branches: ['main'] } : path.endsWith('/continue-as-new') ? { sessionId: 'created-session' } : path.endsWith('/continue') ? { executionId: 'job-1' } : {};
      return Promise.resolve(new Response(JSON.stringify(result), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(path === '/api/task-center/codex' ? { projects } : status), { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  let requests = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `request-${++requests}` });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><HistoryComposer session={selectedSession} historyMessages={[]} canEdit={options.canEdit !== false} syncHistory={async () => []} /></QueryClientProvider>);
  return writes;
}

function switchableCreation(respond: () => Promise<Response>) {
  const origin = { ...session, id: (++nextSession).toString(16).padStart(64, '0') };
  const other = { ...session, id: (++nextSession).toString(16).padStart(64, '0') };
  const targets = [...projects, { ...projects[0]!, id: 'remote-project', deviceId: 'remote-1', deviceName: '远端开发机', cwd: '/remote/default' }];
  const writes: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/continue-as-new')) { writes.push(JSON.parse(String(init?.body))); return respond(); }
    if (url === '/api/task-center/codex') return Promise.resolve(Response.json({ projects: targets }));
    if (url === '/api/task-center/git') return Promise.resolve(Response.json({ repository: true, current: 'main', changes: 0, branches: ['main'] }));
    return Promise.resolve(Response.json({ execution: null, executions: [] }));
  }));
  let requests = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `remount-${++requests}` });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = (selected: Session) => <QueryClientProvider client={client}><HistoryComposer key={selected.id} session={selected} historyMessages={[]} canEdit syncHistory={async () => []} /></QueryClientProvider>;
  const mounted = render(view(origin));
  return { origin, other, targets, client, writes, go: (selected: Session) => { location.hash = `history/${selected.id}`; mounted.rerender(view(selected)); } };
}

describe('HistoryComposer', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('sends to an enabled remote original session without a local desktop link', async () => {
    const remote = { ...session, id: 'b'.repeat(64), deviceId: 'remote', canContinue: true };
    const writes = setup(undefined, false, [], remote);
    const user = userEvent.setup();
    expect(screen.queryByRole('link', { name: /在 Codex 中打开/ })).toBeNull();
    await user.type(screen.getByRole('textbox', { name: '发送消息' }), '继续远端工作');
    await user.click(screen.getByRole('button', { name: '发送消息' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.path).toBe(`/api/agent-sessions/${remote.id}/continue`);
    expect(writes[0]?.body.message).toBe('继续远端工作');
  });

  it('removes live messages when a later connector refresh persists the same completed turn', async () => {
    const remote = { ...session, id: 'c'.repeat(64), deviceId: 'remote', canContinue: true };
    const execution = { id: 'remote-job', turnId: 'remote-turn', status: 'completed', prompt: '核对远端结果', output: '远端检查完成' };
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(
      path === '/api/task-center/codex' ? { projects: [] } : { execution, executions: [execution] }
    ), { status: 200 }))));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const syncHistory = vi.fn(async () => []);
    const { rerender } = render(<QueryClientProvider client={client}><div id="historyLiveOutput" /><HistoryComposer session={remote} historyMessages={[]} canEdit syncHistory={syncHistory} /></QueryClientProvider>);

    expect(await screen.findByText(execution.prompt)).toBeTruthy();
    expect(screen.getByText(execution.output)).toBeTruthy();
    await waitFor(() => expect(syncHistory).toHaveBeenCalledOnce());
    const historyMessages = [{ role: 'user', text: execution.prompt, turnId: execution.turnId }, { role: 'assistant', text: execution.output, turnId: execution.turnId }];
    rerender(<QueryClientProvider client={client}><div id="historyLiveOutput" /><HistoryComposer session={remote} historyMessages={historyMessages} canEdit syncHistory={syncHistory} /></QueryClientProvider>);

    await waitFor(() => expect(screen.queryByText(execution.prompt)).toBeNull());
    expect(screen.queryByText(execution.output)).toBeNull();
    expect(syncHistory).toHaveBeenCalledOnce();
  });

  it('retains the draft and requestId when an uncertain send is retried', async () => {
    const writes = setup(undefined, true);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: '发送消息' }), '继续修复');
    await user.click(screen.getByRole('button', { name: '发送消息' }));
    expect(await screen.findByText(/网络暂不可用/)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveProperty('value', '继续修复');
    await user.click(screen.getByRole('button', { name: '发送消息' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]?.body).toEqual({ message: '继续修复', requestId: 'request-1' });
    expect(writes[1]?.body).toEqual(writes[0]?.body);
  });

  it('does not offer another send while an unknown execution awaits reconciliation', async () => {
    const writes = setup({ execution: { id: 'job-unknown', status: 'unknown', prompt: '之前的消息', message: '结果不确定' }, executions: [{ id: 'job-unknown', status: 'unknown', prompt: '之前的消息', message: '结果不确定' }] });
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: '发送消息' }), '不要重复');
    expect(screen.getByRole('button', { name: '发送消息' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: /带上下文新开会话/ })).toHaveProperty('disabled', true);
    await user.click(await screen.findByRole('button', { name: '核对结果' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({ path: '/api/task-center/execution-action', body: { executionId: 'job-unknown', action: 'reconcile' } });
  });

  it.each(['queued', 'launching', 'running', 'waiting'])('blocks sending or creating a second session while an execution is %s', async (executionStatus) => {
    const writes = setup({ execution: { id: 'busy-job', status: executionStatus, prompt: '正在处理的消息' } });
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: '发送消息' }), '下一条消息');
    expect(screen.getByRole('button', { name: '发送消息' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: /带上下文新开会话/ })).toHaveProperty('disabled', true);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '发送消息' }), { key: 'Enter', ctrlKey: true });
    expect(writes).toHaveLength(0);
  });

  it('shows configuration only in the new session mode and creates an empty session with its selected model', async () => {
    const writes = setup(undefined, false, projects);
    const user = userEvent.setup();
    expect(screen.queryByLabelText('模型与思考强度')).toBeNull();
    expect(screen.queryByRole('combobox', { name: '执行位置' })).toBeNull();
    expect(screen.queryByLabelText('Git 分支')).toBeNull();
    expect(writes).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: /带上下文新开会话/ }));
    await waitFor(() => expect(screen.getByLabelText('Git 分支').textContent).toContain('main'));
    await user.click(screen.getByLabelText('模型与思考强度'));
    expect(screen.getByRole('slider', { name: '思考强度' })).toHaveProperty('value', '1');
    await user.selectOptions(screen.getByRole('combobox', { name: '模型' }), 'gpt-6-sol');
    fireEvent.change(screen.getByRole('slider', { name: '思考强度' }), { target: { value: '2' } });
    expect(screen.getByLabelText('模型与思考强度').textContent).toContain('6 Sol');
    expect(screen.getByLabelText('模型与思考强度').textContent).toContain('高');
    expect(screen.queryByRole('button', { name: '发送消息' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '创建会话' }));
    await waitFor(() => expect(writes.find(item => item.path.endsWith('/continue-as-new'))?.body).toMatchObject({ model: 'gpt-6-sol', reasoningEffort: 'high', message: '' }));
    expect(writes.some(item => item.path.endsWith('/continue'))).toBe(false);
  });

  it('closes an open run configuration menu when clicking elsewhere', async () => {
    const projects = [{ id: 'project-1', deviceId: 'local', deviceName: '本机', name: 'Codex', agent: 'codex', cwd: '/repo', online: true, defaultModel: 'gpt-6-luna', models: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna', defaultReasoningEffort: 'medium', reasoningEfforts: [{ id: 'medium', name: '中' }] }] }];
    setup(undefined, false, projects);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /带上下文新开会话/ }));
    const summary = await screen.findByLabelText('模型与思考强度');
    const details = summary.closest('details');

    await user.click(summary);
    expect(details?.open).toBe(true);
    await user.click(screen.getByRole('textbox', { name: '新会话首条消息（可选）' }));
    expect(details?.open).toBe(false);
  });

  it('keeps the current configuration and draft when returning from new session configuration', async () => {
    const selectedSession = { ...session, id: 'e'.repeat(64), model: 'gpt-6-sol', reasoningEffort: 'high', branch: 'main' };
    const writes = setup(undefined, false, projects, selectedSession);
    const user = userEvent.setup();
    const current = within(screen.getByLabelText('当前会话配置'));
    expect(current.getByText('gpt-6-sol · 高')).toBeTruthy();
    expect(current.getByTitle('/repo')).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: '发送消息' }), '保留草稿');
    await user.click(screen.getByRole('button', { name: /带上下文新开会话/ }));
    await user.click(await screen.findByLabelText('工作目录：/repo'));
    await user.clear(screen.getByRole('textbox', { name: '工作目录' }));
    await user.type(screen.getByRole('textbox', { name: '工作目录' }), '/other-repo');
    await user.click(screen.getByRole('button', { name: '返回当前会话' }));
    expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveProperty('value', '保留草稿');
    expect(screen.getByLabelText('当前会话配置').textContent).toContain('gpt-6-sol · 高');
    expect(screen.getByTitle('/repo')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: '执行位置' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('textbox', { name: '发送消息' }), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(writes.find(item => item.path.endsWith('/continue'))?.body).toEqual({ message: '保留草稿', requestId: 'request-1' }));
    expect(writes.some(item => item.path.endsWith('/continue-as-new'))).toBe(false);
  });

  it('routes the keyboard shortcut to creation in new session mode', async () => {
    const writes = setup(undefined, false, projects);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /带上下文新开会话/ }));
    await screen.findByRole('combobox', { name: '执行位置' });
    await user.type(screen.getByRole('textbox', { name: '新会话首条消息（可选）' }), '检查最新结果');
    fireEvent.keyDown(screen.getByRole('textbox', { name: '新会话首条消息（可选）' }), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(writes.find(item => item.path.endsWith('/continue-as-new'))?.body).toMatchObject({ message: '检查最新结果', cwd: '/repo', requestId: 'request-1' }));
    expect(writes.some(item => item.path.endsWith('/continue'))).toBe(false);
  });

  it('requires an explicit destination directory when creating on another device', async () => {
    const writes = setup(undefined, false, [...projects, { ...projects[0], id: 'remote-project', deviceId: 'remote-1', deviceName: '远端开发机', cwd: '/remote/default' }]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /带上下文新开会话/ }));
    await user.selectOptions(await screen.findByRole('combobox', { name: '执行位置' }), '1');
    await user.click(screen.getByRole('button', { name: '创建会话' }));
    expect(await screen.findByText('跨设备交接请先在目标设备明确选择工作目录。')).toBeTruthy();
    expect(writes.some(item => item.path.endsWith('/continue-as-new'))).toBe(false);
    await user.click(screen.getByLabelText('工作目录：/remote/default'));
    await user.type(screen.getByRole('textbox', { name: '工作目录' }), '/remote/repo');
    await user.click(screen.getByRole('button', { name: '创建会话' }));
    await waitFor(() => expect(writes.find(item => item.path.endsWith('/continue-as-new'))?.body).toMatchObject({ deviceId: 'remote-1', projectId: 'remote-project', cwd: '/remote/repo', message: '' }));
  });

  it('retains a failed creation and retries with the same request identity', async () => {
    const writes = setup(undefined, false, projects, session, { failCreate: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /带上下文新开会话/ }));
    await screen.findByRole('combobox', { name: '执行位置' });
    await user.type(screen.getByRole('textbox', { name: '新会话首条消息（可选）' }), '继续修复');
    await user.click(screen.getByRole('button', { name: '创建并发送' }));
    expect(await screen.findByText(/创建结果暂不可用/)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '新会话首条消息（可选）' })).toHaveProperty('value', '继续修复');
    await user.click(screen.getByRole('button', { name: '返回当前会话' }));
    await user.click(screen.getByRole('button', { name: /带上下文新开会话/ }));
    await user.click(screen.getByRole('button', { name: '创建并发送' }));
    await waitFor(() => expect(writes.filter(item => item.path.endsWith('/continue-as-new'))).toHaveLength(2));
    const creations = writes.filter(item => item.path.endsWith('/continue-as-new'));
    expect(creations[1]?.body).toEqual(creations[0]?.body);
  });

  it('restores new-session mode and its exact failed request after navigating away and reordering targets', async () => {
    const fixture = switchableCreation(async () => Response.json({ message: '创建结果暂不可用' }, { status: 503 }));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /带上下文新开会话/ }));
    await user.selectOptions(await screen.findByRole('combobox', { name: '执行位置' }), '1');
    await user.click(screen.getByLabelText('工作目录：/remote/default'));
    await user.type(screen.getByRole('textbox', { name: '工作目录' }), '/remote/chosen');
    await user.click(screen.getByLabelText('模型与思考强度'));
    await user.selectOptions(screen.getByRole('combobox', { name: '模型' }), 'gpt-6-sol');
    fireEvent.change(screen.getByRole('slider', { name: '思考强度' }), { target: { value: '2' } });
    await user.type(screen.getByRole('textbox', { name: '新会话首条消息（可选）' }), '保留新会话意图');
    await user.click(screen.getByRole('button', { name: '创建并发送' }));
    await screen.findByText(/创建结果暂不可用/);
    fixture.go(fixture.other);
    act(() => fixture.client.setQueryData(['history', 'targets'], { projects: [...fixture.targets].reverse() }));
    fixture.go(fixture.origin);
    expect(screen.queryByRole('textbox', { name: '发送消息' })).toBeNull();
    expect(screen.getByRole('textbox', { name: '新会话首条消息（可选）' })).toHaveProperty('value', '保留新会话意图');
    expect(screen.getByLabelText('工作目录：/remote/chosen')).toBeTruthy();
    expect(screen.getByLabelText('模型与思考强度').textContent).toContain('6 Sol');
    expect(screen.getByLabelText('模型与思考强度').textContent).toContain('高');
    fireEvent.keyDown(screen.getByRole('textbox', { name: '新会话首条消息（可选）' }), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(fixture.writes).toHaveLength(2));
    expect(fixture.writes[1]).toEqual(fixture.writes[0]);
    expect(fixture.writes[1]).toMatchObject({ projectId: 'remote-project', deviceId: 'remote-1', cwd: '/remote/chosen', model: 'gpt-6-sol', reasoningEffort: 'high' });
  });

  it('retains a pending creation across remounts and never navigates away from another active session', async () => {
    let resolve!: (response: Response) => void;
    const response = new Promise<Response>(done => { resolve = done; });
    const fixture = switchableCreation(() => response);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /带上下文新开会话/ }));
    await screen.findByRole('combobox', { name: '执行位置' });
    await user.type(screen.getByRole('textbox', { name: '新会话首条消息（可选）' }), '只创建一次');
    await user.click(screen.getByRole('button', { name: '创建并发送' }));
    await waitFor(() => expect(fixture.writes).toHaveLength(1));
    fixture.go(fixture.other); fixture.go(fixture.origin);
    expect(screen.getByRole('button', { name: '正在创建…' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '返回当前会话' })).toHaveProperty('disabled', true);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '新会话首条消息（可选）' }), { key: 'Enter', ctrlKey: true });
    expect(fixture.writes).toHaveLength(1);
    fixture.go(fixture.other);
    await act(async () => { resolve(Response.json({ sessionId: 'new-created-session' })); await response; });
    await waitFor(() => expect(fixture.client.getMutationCache().getAll().at(-1)?.state.status).toBe('success'));
    expect(location.hash).toBe(`#history/${fixture.other.id}`);
    fixture.go(fixture.origin);
    await waitFor(() => expect(location.hash).toBe('#history/new-created-session'));
    expect(fixture.writes).toHaveLength(1);
  });

  it('offers no sending, configuration, or creation controls to read-only members', () => {
    const writes = setup(undefined, false, projects, session, { canEdit: false });
    expect(screen.getByText('只读成员无法发送消息或新开会话。')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it.each([
    [{ ...session, id: 'f'.repeat(64), managed: true }, '上下文已准备，首次发送时交给 Agent 读取。'],
    [{ ...session, id: 'd'.repeat(64), managed: true, contextSourceDeviceId: 'remote', contextTransferred: false }, '上下文来源已记录，首次发送时将在来源设备读取并准备。']
  ])('describes prepared context without claiming the agent has read it', async (selectedSession, message) => {
    setup(undefined, false, [], selectedSession);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText(/已继承原会话上下文/)).toBeNull();
  });
});
