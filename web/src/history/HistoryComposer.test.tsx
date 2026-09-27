import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../public/taskTypes.js';
import { HistoryComposer } from './HistoryComposer.js';

const id = 'a'.repeat(64);
const session = { id, sessionId: id, agent: 'codex', deviceId: 'local', title: '测试会话', cwd: '/repo', updatedAt: '2026-09-27T00:00:00Z' } satisfies Session;

function setup(status: unknown = { execution: null, executions: [] }, failSend = false) {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  let failures = failSend ? 1 : 0;
  const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      if (path.endsWith('/continue') && failures-- > 0) return Promise.resolve(new Response(JSON.stringify({ message: '网络暂不可用' }), { status: 503 }));
      return Promise.resolve(new Response(JSON.stringify(path.endsWith('/continue') ? { executionId: 'job-1' } : {}), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(path === '/api/task-center/codex' ? { projects: [] } : status), { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('crypto', { randomUUID: () => 'request-1' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><HistoryComposer session={session} historyMessages={[]} canEdit syncHistory={async () => []} /></QueryClientProvider>);
  return writes;
}

describe('HistoryComposer', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
    await user.click(await screen.findByRole('button', { name: '核对结果' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({ path: '/api/task-center/execution-action', body: { executionId: 'job-unknown', action: 'reconcile' } });
  });
});
