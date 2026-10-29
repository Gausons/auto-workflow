import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { Execution, Session, Task, TaskCenterData } from '../../../shared/taskTypes.js';
import { CompletionNotifications } from './CompletionNotifications.js';
import { createCompletionTracker } from './completionTracker.js';

const time = '2020-01-01T10:00:00Z';
const task = (status: Task['status'] = 'running'): Task => ({ id: 'task', title: '修复登录', status, revision: status === 'completed' ? 2 : 1, contextVersion: 1, sessionIds: ['session'], events: [], createdAt: time, updatedAt: time });
const job = (status: Execution['status'] = 'running', fields: Partial<Execution> = {}): Execution => ({ id: 'job', taskId: 'task', title: '执行标题', contextVersion: 1, deviceId: 'local', cwd: '/repo', prompt: '修复', status, createdAt: time, updatedAt: time, ...fields });
const session = (status = 'running', fields: Partial<Session> = {}): Session => ({ id: 'session', title: '排查会话', agent: 'codex', deviceId: 'remote', cwd: '/repo', status, updatedAt: time, ...fields });
const data = (fields: Partial<TaskCenterData> = {}): TaskCenterData => ({ tasks: [], sessions: [], devices: [], executions: [], handoffs: [], ...fields });
const key = ['task-center', 'snapshot'];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('baselines historical records, distinguishes task acceptance from a completed execution, and never repeats a completed execution', () => {
  const observe = createCompletionTracker();
  expect(observe(data({ tasks: [task()], executions: [job('completed', { id: 'historical' }), job()] }))).toEqual([]);
  const completed = data({ tasks: [task('review')], executions: [job('completed', { id: 'historical' }), job('completed')] });
  expect(observe(completed)).toEqual([{ id: 'execution:job', heading: '任务本轮执行完成', title: '修复登录', taskId: 'task' }]);
  expect(observe(completed)).toEqual([]);
  observe(data({ tasks: [task('review')], executions: [job('unknown')] }));
  expect(observe(completed)).toEqual([]);
  const accepted = data({ ...completed, tasks: [task('completed')] });
  expect(observe(accepted)[0]?.heading).toBe('任务已完成');
  expect(observe(accepted)).toEqual([]);
});

it('coalesces simultaneous task and execution completion and supports task reopen', () => {
  const observe = createCompletionTracker();
  observe(data({ tasks: [task()], executions: [job()] }));
  expect(observe(data({ tasks: [task('completed')], executions: [job('completed')] }))).toHaveLength(1);
  observe(data({ tasks: [{ ...task(), revision: 3 }] }));
  expect(observe(data({ tasks: [{ ...task('completed'), revision: 4 }] }))[0]?.heading).toBe('任务已完成');
});

it.each(['failed', 'interrupted', 'unknown', 'blocked'] as const)('never reports %s as completion', status => {
  const observe = createCompletionTracker();
  observe(data({ tasks: [task()], executions: [job()] }));
  expect(observe(data({ tasks: [task('error')], executions: [job(status)] }))).toEqual([]);
});

it('reports managed and original-session turns once, including a later turn in the same session', () => {
  for (const field of ['conversationId', 'historySessionId'] as const) {
    const observe = createCompletionTracker();
    observe(data({ sessions: [session()], executions: [job('running', { [field]: 'session' })] }));
    const completed = data({ sessions: [session('completed')], executions: [job('completed', { [field]: 'session' })] });
    expect(observe(completed)).toEqual([{ id: 'execution:job', heading: '会话本轮已完成', title: '排查会话', sessionId: 'session' }]);
    expect(observe(completed)).toEqual([]);
    observe(data({ sessions: [session()], executions: [job('running', { id: 'next', [field]: 'session' })] }));
    expect(observe(data({ sessions: [session('completed')], executions: [job('completed', { id: 'next', [field]: 'session' })] }))).toHaveLength(1);
  }
});

it('does not double notify generated task sessions, but reports external session transitions', () => {
  const observe = createCompletionTracker();
  observe(data({ tasks: [task()], sessions: [session('running', { source: 'agentExecution' })], executions: [job()] }));
  expect(observe(data({ tasks: [task('review')], sessions: [session('completed', { source: 'agentExecution' })], executions: [job('completed')] }))).toHaveLength(1);
  const external = createCompletionTracker();
  external(data({ sessions: [session()] }));
  expect(external(data({ sessions: [session('completed')] }))[0]?.sessionId).toBe('session');
  expect(external(data({ sessions: [session('completed')] }))).toEqual([]);
});

it('ignores newly imported historical completions and catches a fast execution between updates', () => {
  const observe = createCompletionTracker();
  observe(data());
  expect(observe(data({ tasks: [task('completed')], sessions: [session('completed')], executions: [job('completed')] }))).toEqual([]);
  expect(observe(data({ executions: [job('completed', { id: 'fast', createdAt: new Date(Date.now() + 10).toISOString() })] }))).toHaveLength(1);
});

it('keeps notices across parent page changes, supports viewing and dismissal, and drops them on account remount', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(key, data({ tasks: [task()], sessions: [session()], executions: [job('running', { conversationId: 'session' })] }));
  const onOpen = vi.fn();
  const view = (page: string, account = 'first') => <QueryClientProvider client={client}><h1>{page}</h1><CompletionNotifications key={account} onOpen={onOpen} /></QueryClientProvider>;
  const mounted = render(view('任务'));
  expect(screen.queryByRole('status')).toBeNull();
  mounted.rerender(view('设置'));
  await act(async () => client.setQueryData(key, data({ tasks: [task('review')], sessions: [session('completed')], executions: [job('completed', { conversationId: 'session' })] })));
  expect(await screen.findByText('会话本轮已完成')).toBeTruthy();
  mounted.rerender(view('缺陷'));
  await userEvent.setup().click(screen.getByRole('button', { name: '查看会话' }));
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }));
  expect(screen.queryByRole('status')).toBeNull();
  await act(async () => client.setQueryData(key, data({ tasks: [task('completed')] })));
  expect(await screen.findByText('任务已完成')).toBeTruthy();
  mounted.rerender(view('任务', 'other-account'));
  expect(screen.queryByRole('status')).toBeNull();
});

it('does not miss transitions batched into one React render and does not redisplay dismissed notices', async () => {
  const client = new QueryClient(); client.setQueryData(key, data({ tasks: [task()] }));
  render(<QueryClientProvider client={client}><CompletionNotifications onOpen={() => {}} /></QueryClientProvider>);
  await act(async () => {
    client.setQueryData(key, data({ tasks: [task('completed')] }));
    client.setQueryData(key, data({ tasks: [{ ...task('completed'), title: '完成后更新标题' }] }));
  });
  await userEvent.setup().click(screen.getByRole('button', { name: '关闭完成通知：修复登录' }));
  await act(async () => client.setQueryData(key, data({ tasks: [task('completed')] })));
  expect(screen.queryByRole('status')).toBeNull();
});

it.each([401, 403])('shows no notifications for a denied initial snapshot (%s)', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'denied' }, { status })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><CompletionNotifications onOpen={() => {}} /></QueryClientProvider>);
  await waitFor(() => expect(client.getQueryState(key)?.status).toBe('error'));
  expect(screen.queryByRole('status')).toBeNull();
});

it('retains notices through a transient refresh failure, recovers updates, and hides them after access is revoked', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'offline' }, { status: 503 })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(key, data({ tasks: [task()] }));
  render(<QueryClientProvider client={client}><CompletionNotifications onOpen={() => {}} /></QueryClientProvider>);
  await act(async () => client.setQueryData(key, data({ tasks: [task('completed')] })));
  expect(await screen.findByText('任务已完成')).toBeTruthy();
  await act(async () => { await client.refetchQueries({ queryKey: key }); });
  expect(screen.getByText('任务已完成')).toBeTruthy();
  await act(async () => client.setQueryData(key, data({ tasks: [task('completed')], sessions: [session()] })));
  await act(async () => client.setQueryData(key, data({ tasks: [task('completed')], sessions: [session('completed')] })));
  expect(await screen.findByText('会话本轮已完成')).toBeTruthy();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'denied' }, { status: 403 })));
  await act(async () => { await client.refetchQueries({ queryKey: key }); });
  expect(screen.queryByRole('status')).toBeNull();
});
