import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { HistoryImages } from './HistoryImages.js';

const sessionId = 'a'.repeat(64), imageId = 'b'.repeat(64);
const image = { id: imageId, record: 1, index: 0, text: '<script>用户截图</script>', alt: '原始截图' };
const dataUrl = 'data:image/png;base64,aGVsbG8=';
function show() {
  sessionStorage.setItem('bugflow.sessionToken', 'image-token');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><HistoryImages sessionId={sessionId} count={1} /></QueryClientProvider>);
}
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it('loads metadata and the selected original image on demand with authorization, escaping message text', async () => {
  const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('?')
    ? { images: [image], total: 1, offset: 0, limit: 20 } : { ...image, dataUrl }))));
  vi.stubGlobal('fetch', fetcher); show();
  expect(fetcher).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await user.click(screen.getByText('会话图片（1）'));
  await user.click(await screen.findByRole('button', { name: '第 1 条记录 · 图片 1' }));
  expect((await screen.findByAltText('原始截图')).getAttribute('src')).toBe(dataUrl);
  expect(screen.getByRole('link', { name: '下载原图' }).getAttribute('href')).toBe(dataUrl);
  expect(screen.getByText(image.text)).toBeTruthy(); expect(document.querySelector('script')).toBeNull();
  expect(fetcher.mock.calls).toHaveLength(2);
  for (const [, init] of fetcher.mock.calls) expect(init.headers.Authorization).toBe('Bearer image-token');
  await user.click(screen.getByRole('button', { name: '第 1 条记录 · 图片 1' }));
  expect(screen.queryByAltText('原始截图')).toBeNull();
});

it('keeps a failed image visible with a retry action and reports unavailable source images', async () => {
  let fail = true;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('?')
    ? { images: [image], total: 1, offset: 0, limit: 20 } : fail ? { message: '暂时断网' } : { ...image, alt: '来源图片未保存' }), { status: !url.includes('?') && fail ? 503 : 200 }))));
  show(); const user = userEvent.setup();
  await user.click(screen.getByText('会话图片（1）'));
  await user.click(await screen.findByRole('button', { name: '第 1 条记录 · 图片 1' }));
  expect((await screen.findByRole('alert')).textContent).toContain('暂时断网');
  fail = false; await user.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(await screen.findByText('来源图片未保存')).toBeTruthy();
  expect(screen.queryByRole('img')).toBeNull();
});
