import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api/client.js';
import type { SessionImage, SessionImageInfo } from '../../../shared/historyImageTypes.js';
import styles from './HistoryImages.module.css';

const message = (error: unknown) => error instanceof Error ? error.message : '请求失败';

export function ImagePreview({ sessionId, image }: { sessionId: string; image: SessionImageInfo }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { root: node.closest('.history-chat-scroll'), rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <div ref={host} className={styles.imageSlot}>{visible ? <ImageData sessionId={sessionId} image={image} /> : <p>会话图片</p>}</div>;
}

function ImageData({ sessionId, image }: { sessionId: string; image: SessionImageInfo }) {
  const query = useQuery({
    queryKey: ['history', 'image', sessionId, image.id],
    queryFn: ({ signal }) => apiRequest<SessionImage>(`/api/agent-sessions/${sessionId}/images/${image.id}`, { signal }),
    staleTime: Infinity, gcTime: 0, retry: false
  });
  if (query.isPending) return <p role="status">正在加载图片…</p>;
  if (query.isError) return <p role="alert">图片加载失败：{message(query.error)} <button type="button" onClick={() => void query.refetch()}>重试</button></p>;
  const dataUrl = query.data.dataUrl;
  if (!dataUrl || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(dataUrl)) return <p>{query.data.alt || '来源记录未保存可查看的图片。'}</p>;
  const extension = /^data:image\/([^;]+)/.exec(dataUrl)?.[1] || 'png';
  return <figure className={styles.preview}>
    <img src={dataUrl} alt={image.alt || '会话图片'} />
    <figcaption><a href={dataUrl} download={`会话图片-${image.record}-${image.index + 1}.${extension}`}>下载原图</a></figcaption>
  </figure>;
}
