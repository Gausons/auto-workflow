import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextPreviewResponse, InheritedContextInfo } from '../../../shared/contextPreviewTypes.js';
import { InheritedContext } from './InheritedContext.js';

const id = 'a'.repeat(64), source = 'b'.repeat(64);
const info: InheritedContextInfo = { count: 2, sourceTitle: '原始问题', sourceSessionId: source, availability: 'ready', digest: 'digest-1' };
const preview: ContextPreviewResponse = {
  messages: [{ record: 1, source, role: 'user', text: '<script>查看截图</script>', images: [{ dataUrl: 'data:image/png;base64,aGVsbG8=', alt: '历史截图' }] }, { record: 2, source, role: 'assistant', text: '**尚待验证**' }],
  total: 2, offset: 0, nextOffset: null,
  stats: { users: 1, assistants: 1, tools: 0, references: 0, images: 1, unavailableImages: 0, truncatedMessages: 0, unsupportedBlocks: 0 },
  excerpts: [{ record: 1, source, role: 'user', text: '查看截图' }]
};
function mount(selectedInfo = info) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (sessionId: string, metadata: InheritedContextInfo) => <QueryClientProvider client={client}><InheritedContext id={sessionId} info={metadata} /></QueryClientProvider>;
  const result = render(view(id, selectedInfo));
  return { ...result, update: (metadata: InheritedContextInfo, sessionId = id) => result.rerender(view(sessionId, metadata)) };
}

describe('InheritedContext', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it('loads automatically on expansion and renders safe multimodal detail in a separate drawer', async () => {
    const fetchMock = vi.fn(async () => Response.json(preview)); vi.stubGlobal('fetch', fetchMock);
    mount(); const user = userEvent.setup();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /接续自 原始问题/ }).getAttribute('aria-expanded')).toBe('false');
    await user.click(screen.getByRole('button', { name: /接续自 原始问题/ }));
    expect(await screen.findByText('查看截图')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: '原始问题' }).getAttribute('href')).toBe(`#history/${source}`);
    expect(screen.queryByRole('img')).toBeNull();
    await user.click(screen.getByRole('button', { name: '查看上下文明细' }));
    const drawer = screen.getByRole('dialog', { name: '继承上下文明细' });
    expect(within(drawer).getByRole('img', { name: '历史截图' })).toBeTruthy();
    expect(within(drawer).getByText('尚待验证').tagName).toBe('STRONG');
    expect(within(drawer).getByText('<script>查看截图</script>')).toBeTruthy();
    expect(drawer.querySelector('script')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭明细' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '查看上下文明细' }));
  });

  it('shows a retry on failure and loads subsequent records only from the drawer', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ message: '读取失败' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ...preview, messages: [preview.messages[0]], nextOffset: 1 }))
      .mockResolvedValueOnce(Response.json({ ...preview, messages: [preview.messages[1]], offset: 1 }));
    vi.stubGlobal('fetch', fetchMock); mount(); const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /接续自 原始问题/ }));
    await user.click(await screen.findByRole('button', { name: '重试读取上下文' }));
    await user.click(await screen.findByRole('button', { name: '查看上下文明细' }));
    await user.click(screen.getByRole('button', { name: '加载更多记录' }));
    expect(await screen.findByText('已显示 2 / 2 条可预览记录')).toBeTruthy();
    expect(fetchMock.mock.calls[2]?.[0]).toContain('offset=1');
  });

  it('reloads changed snapshots and closes details when navigating to another session', async () => {
    const fetchMock = vi.fn(async () => Response.json(preview)); vi.stubGlobal('fetch', fetchMock);
    const view = mount(); const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /接续自 原始问题/ }));
    await screen.findByText('查看截图');
    view.update({ ...info, digest: 'digest-2' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await user.click(await screen.findByRole('button', { name: '查看上下文明细' }));
    view.update(info, 'c'.repeat(64));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /接续自 原始问题/ }).getAttribute('aria-expanded')).toBe('false');
    expect(document.body.style.overflow).toBe('');
  });

  it('distinguishes device preparation from the partial browser preview', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(preview)));
    const view = mount({ ...info, count: 1, availability: 'remote', partial: true });
    const user = userEvent.setup();
    expect(screen.getByText(/实际携带量待回报/)).toBeTruthy();
    view.update({ ...info, count: 1, availability: 'remote', partial: true, coverage: { records: 72, images: 2, partial: false } });
    expect(screen.getByText(/来源设备已准备上下文 · 72 条记录 · 2 张图片/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /接续自 原始问题/ }));
    expect(screen.getByText(/工作台仅能预览已保存的摘要/)).toBeTruthy();
    expect(screen.queryByText(/来源记录不完整/)).toBeNull();
  });

  it('does not fetch an obsolete placeholder while the source turn is still running', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    mount({ ...info, availability: 'pending' });
    await userEvent.setup().click(screen.getByRole('button', { name: /接续自 原始问题/ }));
    expect(screen.getByText('等待来源会话本轮结束后准备上下文。')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
