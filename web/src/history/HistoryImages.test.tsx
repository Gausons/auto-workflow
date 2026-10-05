import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ImagePreview } from './HistoryImages.js';

const sessionId = 'a'.repeat(64), imageId = 'b'.repeat(64);
const image = { id: imageId, record: 1, index: 0, text: '<script>用户截图</script>', alt: '原始截图' };
const dataUrl = 'data:image/png;base64,aGVsbG8=';
function show() {
  sessionStorage.setItem('bugflow.sessionToken', 'image-token');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ImagePreview sessionId={sessionId} image={image} /></QueryClientProvider>);
}
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it('loads an original image with authorization and offers a download', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...image, dataUrl })));
  vi.stubGlobal('fetch', fetcher); show();
  expect((await screen.findByAltText('原始截图')).getAttribute('src')).toBe(dataUrl);
  expect(screen.getByRole('link', { name: '下载原图' }).getAttribute('href')).toBe(dataUrl);
  expect(fetcher.mock.calls).toHaveLength(1);
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer image-token');
});

it('keeps a failed image visible with a retry action and reports unavailable source images', async () => {
  let fail = true;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(
    fail ? { message: '暂时断网' } : { ...image, alt: '来源图片未保存' }), { status: fail ? 503 : 200 }))));
  show(); const user = userEvent.setup();
  expect((await screen.findByRole('alert')).textContent).toContain('暂时断网');
  fail = false; await user.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(await screen.findByText('来源图片未保存')).toBeTruthy();
  expect(screen.queryByRole('img')).toBeNull();
});
