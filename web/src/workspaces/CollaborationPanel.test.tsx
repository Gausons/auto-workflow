import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import type { CollaborationDetail } from '../../../shared/collaborationTypes.js';
import { CollaborationPanel } from './CollaborationPanel.js';

const base = '/api/workspaces/collaborations';
const at = '2026-11-22T06:00:00Z';
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.unstubAllGlobals(); });
function setup(options: { viewer?: boolean; empty?: boolean; failure?: boolean; unresolved?: boolean; completed?: 'parent' | 'participant'; legacy?: boolean } = {}) {
  const detail: CollaborationDetail = {
    id: 'collab', parentTaskId: 'parent', title: '订单查询', goal: '用统一协议查询订单', createdAt: at, updatedAt: at, revision: 5,
    taskStatus: options.completed === 'parent' ? 'completed' : 'ready', participantCount: 2, documentCount: 2,
    participants: [
      { id: 'api', taskId: 'task-api', name: '接口组', responsibility: '提供查询接口', deviceId: 'backend-host', projectId: 'backend', agent: 'codex', cwd: '/repos/backend' },
      { taskStatus: options.completed === 'participant' ? 'completed' : 'ready', id: 'app', taskId: 'task-app', name: '应用组', responsibility: '实现应用页面', deviceId: 'mobile-host', projectId: 'mobile', agent: 'claude', cwd: '/repos/mobile' },
    ],
    documents: [
      { id: 'dto', fromParticipantId: 'api', toParticipantId: 'app', title: '响应字段清单', body: '<script>文本示例</script>', createdAt: at, createdBy: 'member' },
      { id: 'feedback', fromParticipantId: 'app', toParticipantId: 'api', title: '分页参数反馈', body: '每页二十条', createdAt: at, createdBy: 'member' },
    ],
    runs: [{ id: 'r1', participantId: 'api', executionId: 'exec-api', documentIds: [], instruction: '', createdAt: at, createdBy: 'member', status: 'completed', output: '  code\n', message: '执行完成', releaseStatus: options.unresolved ? 'failed' : 'released' }],
  };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      requests.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (options.failure) return Response.json({ message: '设备暂不可用' }, { status: 503 });
      return Response.json({ id: path === base ? detail.id : 'saved' });
    }
    if (path === base) return Response.json({ collaborations: options.empty ? [] : [detail] });
    if (path === base + '/collab') return Response.json({ collaboration: detail });
    if (path === '/api/task-center/codex') return Response.json({ projects: detail.participants.map(item => ({ id: item.projectId, name: item.name, deviceId: item.deviceId, cwd: item.cwd, agent: item.agent, collaborationSessions: options.legacy ? undefined : true })) });
    throw new Error(path);
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><MemoryRouter><CollaborationPanel workspaceId="team" canExecute={!options.viewer} /></MemoryRouter></QueryClientProvider>);
  return { user: userEvent.setup(), requests, detail, fetchMock };
}
async function openDetail(options: Parameters<typeof setup>[0] = {}) {
  const result = setup(options);
  await result.user.click(await screen.findByRole('button', { name: /订单查询/ }));
  await screen.findByRole('heading', { name: '订单查询' });
  return result;
}
it('creates independent device assignments and opens the resulting collaboration without launching it', async () => {
  const { user, requests } = setup({ empty: true });
  await user.click(screen.getByRole('button', { name: '新建协作任务' }));
  await user.type(screen.getByLabelText('任务名称'), '订单查询');
  await user.type(screen.getByLabelText('共同目标'), '查询订单');
  const first = within(screen.getByRole('group', { name: '分工 1' }));
  const second = within(screen.getByRole('group', { name: '分工 2' }));
  await user.type(first.getByLabelText('分工名称'), '接口组');
  await user.selectOptions(first.getByLabelText('执行目标'), JSON.stringify(['backend-host', 'backend']));
  await user.type(first.getByLabelText('职责'), '提供接口');
  await user.type(second.getByLabelText('分工名称'), '应用组');
  await user.selectOptions(second.getByLabelText('执行目标'), JSON.stringify(['mobile-host', 'mobile']));
  await user.type(second.getByLabelText('职责'), '开发应用');
  expect(first.getByText('/repos/backend')).toBeTruthy();
  expect(second.getByText('/repos/mobile')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '创建协作任务' }));
  expect(await screen.findByRole('article', { name: '接口组' })).toBeTruthy();
  expect(requests).toEqual([{ path: base, body: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), title: '订单查询', goal: '查询订单', participants: [
    { name: '接口组', responsibility: '提供接口', deviceId: 'backend-host', projectId: 'backend' },
    { name: '应用组', responsibility: '开发应用', deviceId: 'mobile-host', projectId: 'mobile' },
  ] } }]);
});
it('prepares a document from a completed run, preserving Markdown whitespace and binding the source', async () => {
  const { user, requests } = await openDetail();
  await user.click(screen.getByText('第 1 轮 · 本轮已完成'));
  await user.click(screen.getByRole('button', { name: '整理为交接文档' }));
  expect(screen.getByLabelText('来源分工')).toHaveProperty('disabled', true);
  expect(screen.getByLabelText('接收分工')).toHaveProperty('value', 'app');
  expect(screen.getByLabelText('文档正文')).toHaveProperty('value', '  code\n');
  await user.type(screen.getByLabelText('文档标题'), '订单字段');
  fireEvent.change(screen.getByLabelText('文档正文'), { target: { value: '    orderId\n\n' } });
  await user.click(screen.getByRole('button', { name: '发布文档' }));
  expect(await screen.findByText('交接文档已发布。')).toBeTruthy();
  expect(requests).toEqual([{ path: base + '/collab/documents', body: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), revision: 5, fromParticipantId: 'api', toParticipantId: 'app', title: '订单字段', body: '    orderId\n\n', sourceExecutionId: 'exec-api' } }]);
});
it('includes only explicitly selected incoming documents and preserves a failed run for intentional retry', async () => {
  const { user, requests } = await openDetail({ failure: true });
  const app = within(screen.getByRole('article', { name: '应用组' }));
  await user.click(app.getByRole('button', { name: '启动分工' }));
  expect(app.queryByRole('checkbox', { name: '分页参数反馈' })).toBeNull();
  const doc = app.getByRole('checkbox', { name: '响应字段清单' });
  expect(doc).toHaveProperty('checked', false);
  await user.click(doc);
  await user.type(app.getByLabelText('本轮指令'), '联调');
  await user.click(app.getByRole('button', { name: '确认启动' }));
  expect(await app.findByRole('alert')).toHaveProperty('textContent', '设备暂不可用');
  expect(app.getByLabelText('本轮指令')).toHaveProperty('value', '联调');
  expect(requests).toEqual([{ path: base + '/collab/runs', body: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), revision: 5, participantId: 'app', instruction: '联调', documentIds: ['dto'] } }]);
  await user.click(app.getByRole('button', { name: '确认启动' }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]).toEqual(requests[0]);
});
it('allows viewers to read documents as text without exposing actions or requesting execution targets', async () => {
  const { user, fetchMock } = await openDetail({ viewer: true });
  await user.click(screen.getByText('响应字段清单'));
  expect(screen.getByText('<script>文本示例</script>')).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
  expect(screen.queryByRole('button', { name: '编写交接文档' })).toBeNull();
  expect(screen.queryByRole('button', { name: '启动分工' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '← 全部协作任务' }));
  expect(screen.queryByRole('button', { name: '新建协作任务' })).toBeNull();
  expect(fetchMock.mock.calls.some(([path]) => path === '/api/task-center/codex')).toBe(false);
});
it('keeps an unresolved release available for inspection and blocks further runs and publication from that run', async () => {
  const { user } = await openDetail({ unresolved: true });
  await user.click(screen.getByText('第 1 轮 · 本轮已完成'));
  const card = within(screen.getByRole('article', { name: '接口组' }));
  expect(card.getByRole('button', { name: '启动下一轮' })).toHaveProperty('disabled', true);
  expect(card.queryByRole('button', { name: '整理为交接文档' })).toBeNull();
  const open = vi.fn(); window.addEventListener('bugflow:open-task', open);
  try {
    await user.click(card.getByRole('button', { name: '查看执行' }));
    expect(open.mock.calls[0][0].detail.taskId).toBe('task-api');
  } finally { window.removeEventListener('bugflow:open-task', open); }
});

it.each(['parent', 'participant'] as const)('honors a completed %s task and links to the task that can be reopened', async completed => {
  const { user } = await openDetail({ completed });
  const app = within(screen.getByRole('article', { name: '应用组' }));
  const api = within(screen.getByRole('article', { name: '接口组' }));
  expect(app.getByRole('button', { name: '启动分工' })).toHaveProperty('disabled', true);
  expect(api.getByRole('button', { name: '启动下一轮' })).toHaveProperty('disabled', completed === 'parent');
  const open = vi.fn(); window.addEventListener('bugflow:open-task', open);
  try {
    const button = completed === 'parent' ? screen.getByRole('button', { name: '查看共同任务 ↗' }) : app.getByRole('button', { name: '查看分工任务' });
    await user.click(button);
    expect(open.mock.calls[0][0].detail.taskId).toBe(completed === 'parent' ? 'parent' : 'task-app');
  } finally { window.removeEventListener('bugflow:open-task', open); }
});

it('identifies older connectors and prevents selecting their projects for a collaboration', async () => {
  const { user } = setup({ empty: true, legacy: true });
  await user.click(screen.getByRole('button', { name: '新建协作任务' }));
  const first = within(screen.getByRole('group', { name: '分工 1' }));
  expect(await first.findByRole('option', { name: /接口组.*需升级连接器/ })).toHaveProperty('disabled', true);
  expect(screen.getByText(/远端设备需升级连接器并重新连接/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '创建协作任务' })).toHaveProperty('disabled', true);
});
