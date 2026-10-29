import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/taskTypes.js';
import { HistoryTranscript } from './HistoryTranscript.js';

const session: Session = { id: 'a'.repeat(64), agent: 'codex', deviceId: 'remote', title: '远端会话', cwd: '/repo', updatedAt: '', recordMode: 'synced', syncedImageCount: 2,
  syncedRange: { offset: 10, total: 12, sourcePartial: false, truncated: false } };
const dataUrl = 'data:image/png;base64,aGVsbG8=';
const earlier = { id: 'b'.repeat(64), record: 1, index: 0, text: '<script>早期截图</script>', alt: '较早图片' };
const inline = { id: 'c'.repeat(64), record: 11, index: 0, text: '查看截图', alt: '消息内图片' };
const messages = [{ role: 'user', text: '查看截图', images: [{ external: true as const, alt: '单独同步' }] }, { role: 'assistant', text: '**回复**' }];
function show(selected = session) {
  sessionStorage.setItem('bugflow.sessionToken', 'test-token');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><HistoryTranscript session={selected} messages={messages} /></QueryClientProvider>);
}
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it.each(['remote', 'local'])('shows desktop question replies as readable questions and answers in %s history', deviceId => {
  const text = `<send_user_message_question_reply>\n${JSON.stringify([
    { questionItemId: JSON.stringify(['request_user_input_async', 'call-123', 0]), question: '向量搜索希望覆盖哪些内容？', answer: '任务、缺陷和历史会话都支持' },
    { questionItemId: 'second', question: '保留关键词匹配？', answer: '保留\n<script>只是文本</script> **原文**' }
  ])}\n</send_user_message_question_reply>`;
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><HistoryTranscript session={{ ...session, deviceId, recordMode: deviceId === 'local' ? undefined : 'synced', syncedImageCount: 0 }} messages={[
    { role: 'user', text, timestamp: '2026-10-21T06:11:00Z', images: [{ dataUrl, alt: '回答附件' }] },
    { role: 'assistant', text: '收到' }
  ]} /></QueryClientProvider>);
  expect(screen.getByText('向量搜索希望覆盖哪些内容？')).toBeTruthy();
  expect(screen.getByText('任务、缺陷和历史会话都支持', { exact: false })).toBeTruthy();
  expect(screen.getByText('保留关键词匹配？')).toBeTruthy();
  expect(screen.getByText('保留 <script>只是文本</script> **原文**', { exact: false })).toBeTruthy();
  expect(screen.getByAltText('回答附件').closest('.history-message.user')).toBeTruthy();
  expect(document.querySelector('time')?.dateTime).toBe('2026-10-21T06:11:00.000Z');
  expect(document.querySelector('script')).toBeNull();
  expect(document.body.textContent).not.toMatch(/send_user_message_question_reply|questionItemId|request_user_input_async|call-123/);
  expect(screen.getByText('收到')).toBeTruthy();
});

it('reads all metadata pages, restores external images in messages, and labels earlier image context without inventing a role', async () => {
  const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('offset=0')
    ? { images: [earlier], total: 2 } : url.includes('offset=1') ? { images: [inline], total: 2 }
      : { ...(url.endsWith(inline.id) ? inline : earlier), dataUrl }))));
  vi.stubGlobal('fetch', fetcher); show();
  const restored = await screen.findByAltText('消息内图片');
  expect(restored.closest('.history-message.user')?.textContent).toContain('查看截图');
  expect(screen.queryByText('单独同步')).toBeNull();
  const older = await screen.findByAltText('较早图片');
  expect(older.closest('.history-message.user')).toBeNull();
  expect(screen.getByText('以下图片来自更早的记录，完整正文未同步。')).toBeTruthy();
  expect(screen.getByText(earlier.text)).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
  expect(fetcher.mock.calls).toHaveLength(4);
  for (const [, init] of fetcher.mock.calls) expect(init.headers.Authorization).toBe('Bearer test-token');
});

it('retains transcript and missing-image hints on metadata failure and restores images after retry', async () => {
  let failed = true;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('?')
    ? failed ? { message: '暂时断网' } : { images: [inline], total: 1 }
    : { ...inline, dataUrl }), { status: url.includes('?') && failed ? 503 : 200 }))));
  show();
  expect((await screen.findByRole('alert')).textContent).toContain('暂时断网');
  expect(screen.getByText('单独同步')).toBeTruthy();
  expect(screen.getByText('回复')).toBeTruthy();
  failed = false;
  await userEvent.setup().click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByAltText('消息内图片')).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

it('keeps existing inline image data and does not download a duplicate original', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ images: [inline], total: 1 })));
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><HistoryTranscript session={session} messages={[{ role: 'user', text: '截图', images: [{ dataUrl, alt: '原图' }] }]} /></QueryClientProvider>);
  expect(await screen.findByAltText('原图')).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('正在读取会话图片…')).toBeNull());
  expect(screen.getAllByRole('img')).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
