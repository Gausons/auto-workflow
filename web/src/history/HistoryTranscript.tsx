import { useQuery } from '@tanstack/react-query';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionImageInfo, SessionImageList } from '../../../shared/historyImageTypes.js';
import type { HistoryMessage, Session } from '../../../shared/taskTypes.js';
import { apiRequest } from '../api/client.js';
import { escape, renderImages, renderMessages } from '../components/historyView.js';
import { ImagePreview } from './HistoryImages.js';
import styles from './HistoryImages.module.css';

const noImages: SessionImageInfo[] = [];

function Messages({ sessionId, messages, offset, images }: { sessionId: string; messages: HistoryMessage[]; offset: number; images: SessionImageInfo[] }) {
  const host = useRef<HTMLDivElement>(null);
  const rendered = useRef<string | null>(null);
  const [slots, setSlots] = useState<Array<{ node: Element; image: SessionImageInfo }>>([]);
  const html = useMemo(() => {
    const byRecord = new Map(images.map(image => [`${image.record}:${image.index}`, image]));
    const records = new Map(messages.map((message, index) => [message, offset + index + 1]));
    return renderMessages(messages, message => message.images?.map((image, index) => {
      const saved = byRecord.get(`${records.get(message)}:${index}`);
      return saved && !image.dataUrl ? `<div class="history-images" data-history-image="${escape(saved.id)}"></div>` : renderImages([image]);
    }).join('') || '');
  }, [messages, offset, images]);
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    const scroll = node.closest<HTMLElement>('.history-chat-scroll');
    const follow = scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
    if (rendered.current !== html) { node.innerHTML = html; rendered.current = html; }
    const byId = new Map(images.map(image => [image.id, image]));
    setSlots(Array.from(node.querySelectorAll('[data-history-image]')).flatMap(node => {
      const image = byId.get(node.getAttribute('data-history-image') || '');
      return image ? [{ node, image }] : [];
    }));
    if (follow && scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [html, images]);
  return <><div className="history-messages" data-history-transcript ref={host} />{slots.map(({ node, image }) => createPortal(<ImagePreview sessionId={sessionId} image={image} />, node, image.id))}</>;
}

export function HistoryTranscript({ session, messages }: { session: Session; messages: HistoryMessage[] }) {
  const query = useQuery({
    queryKey: ['history', 'detail', session.id, 'image-metadata', session.syncedImageCount],
    enabled: session.recordMode === 'synced' && Boolean(session.syncedImageCount),
    retry: false,
    queryFn: async ({ signal }) => {
      const images: SessionImageInfo[] = [];
      // Metadata is small and bounded by the server's 1000-image quota. Original
      // bytes are fetched separately, only when a preview approaches the viewport.
      let page: SessionImageList;
      do {
        page = await apiRequest<SessionImageList>(`/api/agent-sessions/${session.id}/images?offset=${images.length}&limit=50`, { signal });
        images.push(...page.images);
      } while (page.images.length && images.length < page.total);
      return images;
    }
  });
  const images = query.data || noImages;
  const offset = session.recordMode === 'synced' ? session.syncedRange?.offset || 0 : 0;
  const earlier = images.filter(image => image.record <= offset);
  const groups = new Map<number, SessionImageInfo[]>();
  for (const image of earlier) groups.set(image.record, [...(groups.get(image.record) || []), image]);
  return <>
    {query.isLoading && <p className="history-meta" role="status">正在读取会话图片…</p>}
    {query.isError && <p role="alert">图片列表加载失败：{query.error.message} <button type="button" onClick={() => void query.refetch()}>重试</button></p>}
    {groups.size > 0 && <section className={styles.earlier} aria-label="较早记录中的图片">
      <p className="history-meta">以下图片来自更早的记录，完整正文未同步。</p>
      {[...groups].map(([record, items]) => <article key={record}>
        <small>第 {record} 条记录 · 图片附带文本</small>
        {items[0]?.text && <p>{items[0].text}</p>}
        {items.map(image => <ImagePreview key={image.id} sessionId={session.id} image={image} />)}
      </article>)}
    </section>}
    <Messages sessionId={session.id} messages={messages} offset={offset} images={images} />
  </>;
}
