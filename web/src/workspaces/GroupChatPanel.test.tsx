import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { GroupChatRoom } from '../../../shared/groupChatTypes.js';
import { GroupChatPanel } from './GroupChatPanel.js';

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.unstubAllGlobals(); });
function setup(options: { viewer?: boolean; empty?: boolean; failure?: boolean; running?: boolean; local?: boolean; directoryStatus?: string; pendingDirectory?: boolean } = {}) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let exists = !options.empty;
  const room: GroupChatRoom = { id: 'room-1', name: '方案讨论', revision: 1, createdBy: 'owner', createRequestId: 'create-id', createFingerprint: '', createdAt: '', updatedAt: '', participants: ['codex', 'claude'].map(agent => ({ id: agent, name: agent, responsibility: '', agent, deviceId: 'remote', projectId: agent, cwd: '/repo' })), messages: [{ id: 'message-1', roundId: 'round-1', role: 'user', authorId: 'me', authorName: '小王', text: '如何改进架构？', status: 'completed', createdAt: '' }, { id: 'message-2', roundId: 'round-1', role: 'agent', authorId: 'codex', authorName: 'codex', text: '<script>不可信输出</script>', status: options.running ? 'running' : 'completed', executionId: 'execution-1', taskId: 'task-1', createdAt: '' }], round: { id: 'round-1', actorId: 'me', status: options.running ? 'running' : 'completed' } };
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    let data: unknown;
    if (init?.method === 'POST') {
      requests.push({ path: input, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (input === '/api/task-center/directory-picker') return Response.json({ status: options.pendingDirectory ? 'pending' : options.directoryStatus || 'completed', requestId: '11111111-1111-4111-8111-111111111111', cwd: '/selected/repo', message: '设备选择失败' });
      if (options.failure) return new Response(JSON.stringify({ message: '执行提交状态待核对' }), { status: 503 });
      exists = true; data = { id: room.id };
    } else if (input.startsWith('/api/task-center/directory-picker?')) data = { status: options.directoryStatus || 'completed', cwd: '/selected/repo' };
    else if (input === '/api/workspaces/chats') data = { rooms: exists ? [room] : [] };
    else if (input === '/api/task-center/codex') data = { projects: ['codex', 'claude'].map(agent => ({ id: agent, agent, deviceId: options.local ? 'local' : 'remote', deviceName: '研发设备', cwd: '/repo', online: true })) };
    else data = { room };
    return new Response(JSON.stringify(data), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><GroupChatPanel workspaceId="team-1" canExecute={!options.viewer} /></QueryClientProvider>);
  return { requests, fetchMock };
}
it('creates a room with multiple named agents and their responsibilities', async () => {
  const { requests } = setup({ empty: true }); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '＋ 新建聊天室' }));
  await user.type(screen.getByLabelText('聊天室名称'), '安全评审');
  const fields = await screen.findAllByRole('group');
  for (let index = 0; index < fields.length; index++) {
    await user.selectOptions(within(fields[index]).getByLabelText('执行目标'), JSON.stringify(['remote', index ? 'claude' : 'codex']));
  }
  await user.type(within(fields[1]).getByLabelText('讨论职责（可选）'), '检查权限');
  await user.click(screen.getByRole('button', { name: '创建聊天室' }));
  expect(await screen.findByRole('heading', { name: '方案讨论' })).toBeTruthy();
  expect(requests[0].body).toMatchObject({ name: '安全评审', participants: [{ name: 'Agent 1', deviceId: 'remote', projectId: 'codex', cwd: '/repo' }, { name: 'Agent 2', projectId: 'claude', cwd: '/repo', responsibility: '检查权限' }] });
  expect(requests[0].body.requestId).toMatch(/^[a-f0-9-]{36}$/);
});
it('sends a discussion round and opens the original execution task', async () => {
  const { requests } = setup(); const user = userEvent.setup();
  expect(await screen.findByText('<script>不可信输出</script>')).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
  const listener = vi.fn(); window.addEventListener('bugflow:open-task', listener);
  await user.click(screen.getByRole('button', { name: '查看执行' }));
  expect(listener.mock.calls[0][0].detail.taskId).toBe('task-1'); window.removeEventListener('bugflow:open-task', listener);
  await user.type(screen.getByLabelText('讨论消息'), '请继续评估风险');
  await user.click(screen.getByRole('button', { name: '发送并开始讨论' }));
  await waitFor(() => expect(requests[0]).toMatchObject({ path: '/api/workspaces/chats/room-1/messages', body: { message: '请继续评估风险', revision: 1 } }));
  expect(screen.getByLabelText('讨论消息')).toHaveProperty('value', '');
});
it('preserves failed drafts and reuses the request ID only on an explicit retry', async () => {
  const { requests } = setup({ failure: true }); const user = userEvent.setup();
  await user.type(await screen.findByLabelText('讨论消息'), '继续'); await user.click(screen.getByRole('button', { name: '发送并开始讨论' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '执行提交状态待核对');
  expect(requests).toHaveLength(1); expect(screen.getByLabelText('讨论消息')).toHaveProperty('value', '继续');
  await user.click(screen.getByRole('button', { name: '发送并开始讨论' }));
  await waitFor(() => expect(requests).toHaveLength(2)); expect(requests[1].body.requestId).toBe(requests[0].body.requestId);
});
it('stops a running round and prevents overlapping submissions', async () => {
  const { requests } = setup({ running: true }); const user = userEvent.setup();
  expect(await screen.findByLabelText('讨论消息')).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: '发送并开始讨论' })).toHaveProperty('disabled', true);
  await user.click(screen.getByRole('button', { name: '停止讨论' }));
  await waitFor(() => expect(requests).toEqual([{ path: '/api/workspaces/chats/room-1/stop', body: { revision: 1, roundId: 'round-1' } }]));
});
it('viewers read group history without write controls or target discovery', async () => {
  const { fetchMock } = setup({ viewer: true });
  expect(await screen.findByText('如何改进架构？')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '＋ 新建聊天室' })).toBeNull();
  expect(screen.queryByLabelText('讨论消息')).toBeNull();
  expect(fetchMock.mock.calls.some(([path]) => path === '/api/task-center/codex')).toBe(false);
});

async function openCreate(options: Parameters<typeof setup>[0] = {}) {
  const result = setup({ empty: true, ...options }); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '＋ 新建聊天室' }));
  await user.type(screen.getByLabelText('聊天室名称'), '目录讨论');
  const fields = await screen.findAllByRole('group');
  for (let index = 0; index < fields.length; index++) await user.selectOptions(within(fields[index]).getByLabelText('执行目标'), JSON.stringify([options.local ? 'local' : 'remote', index ? 'claude' : 'codex']));
  return { ...result, user, fields };
}
it('selects each remote agent directory independently and sends the confirmed grant', async () => {
  const { requests, user, fields } = await openCreate({ pendingDirectory: true });
  expect(within(fields[0]).getByLabelText('工作目录')).toHaveProperty('value', '/repo');
  await user.click(within(fields[0]).getByRole('button', { name: '选择目录' }));
  await waitFor(() => expect(within(fields[0]).getByLabelText('工作目录')).toHaveProperty('value', '/selected/repo'), { timeout: 4500 });
  expect(within(fields[1]).getByLabelText('工作目录')).toHaveProperty('value', '/repo');
  await user.clear(within(fields[1]).getByLabelText('工作目录'));
  expect(screen.getByRole('button', { name: '创建聊天室' })).toHaveProperty('disabled', true);
  await user.type(within(fields[1]).getByLabelText('工作目录'), '/repo/second');
  await user.click(screen.getByRole('button', { name: '创建聊天室' }));
  await waitFor(() => expect(requests.find(item => item.path === '/api/workspaces/chats')?.body.participants).toMatchObject([{ cwd: '/selected/repo', directoryRequestId: '11111111-1111-4111-8111-111111111111' }, { cwd: '/repo/second' }]));
  expect(requests.filter(item => item.path === '/api/task-center/directory-picker')).toHaveLength(1);
});
it('resets a directory grant when changing targets or editing the path', async () => {
  const { requests, user, fields } = await openCreate();
  await user.click(within(fields[0]).getByRole('button', { name: '选择目录' }));
  await waitFor(() => expect(within(fields[0]).getByLabelText('工作目录')).toHaveProperty('value', '/selected/repo'), { timeout: 4500 });
  await user.selectOptions(within(fields[0]).getByLabelText('执行目标'), JSON.stringify(['remote', 'claude']));
  expect(within(fields[0]).getByLabelText('工作目录')).toHaveProperty('value', '/repo');
  await user.click(within(fields[1]).getByRole('button', { name: '选择目录' }));
  await waitFor(() => expect(within(fields[1]).getByLabelText('工作目录')).toHaveProperty('value', '/selected/repo'), { timeout: 4500 });
  await user.clear(within(fields[1]).getByLabelText('工作目录')); await user.type(within(fields[1]).getByLabelText('工作目录'), '/repo/edited');
  await user.click(screen.getByRole('button', { name: '创建聊天室' }));
  await waitFor(() => expect(requests.find(item => item.path === '/api/workspaces/chats')?.body.participants).toEqual([{ name: 'Agent 1', responsibility: '', deviceId: 'remote', projectId: 'claude', cwd: '/repo' }, { name: 'Agent 2', responsibility: '', deviceId: 'remote', projectId: 'claude', cwd: '/repo/edited' }]));
});
it.each(['cancelled', 'failed'])('keeps the previous directory when the picker is %s', async status => {
  const { requests, user, fields } = await openCreate({ directoryStatus: status });
  await user.click(within(fields[0]).getByRole('button', { name: '选择目录' }));
  expect(await screen.findByText(status === 'cancelled' ? '已取消选择目录' : '设备选择失败')).toBeTruthy();
  expect(within(fields[0]).getByLabelText('工作目录')).toHaveProperty('value', '/repo');
  expect(requests).toHaveLength(1);
});
it('uses the local native picker and can restore the default directory', async () => {
  const { user, fields } = await openCreate({ local: true });
  await user.click(within(fields[0]).getByRole('button', { name: '选择目录' }));
  await waitFor(() => expect(within(fields[0]).getByLabelText('工作目录')).toHaveProperty('value', '/selected/repo'), { timeout: 4500 });
  await user.click(within(fields[0]).getByRole('button', { name: '使用默认目录' }));
  expect(within(fields[0]).getByLabelText('工作目录')).toHaveProperty('value', '/repo');
});
it('cancels a pending directory selection without applying a late result to the form', async () => {
  const { user, requests } = await openCreate({ pendingDirectory: true });
  await user.click(within(screen.getAllByRole('group')[0]).getByRole('button', { name: '选择目录' }));
  expect(await screen.findByText('请在目标设备选择并确认工作目录。')).toBeTruthy();
  expect(screen.getByRole('button', { name: '创建聊天室' })).toHaveProperty('disabled', true);
  await user.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByLabelText('聊天室名称')).toBeNull();
  await user.click(screen.getByRole('button', { name: '＋ 新建聊天室' }));
  expect(within(screen.getAllByRole('group')[0]).getByLabelText('工作目录')).toHaveProperty('value', '/repo');
  expect(requests).toHaveLength(1);
});
