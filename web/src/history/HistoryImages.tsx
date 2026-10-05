import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { apiRequest } from '../api/client.js';
import type { SessionImage, SessionImageInfo, SessionImageList } from '../../../shared/historyImageTypes.js';
import styles from './HistoryImages.module.css';

const message = (error: unknown) => error instanceof Error ? error.message : '请求失败';

function ImagePreview({ sessionId, image }: { sessionId: string; image: SessionImageInfo }) {
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

export function HistoryImages({ sessionId, count }: { sessionId: string; count: number }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: ['history', 'detail', sessionId, 'images'],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => apiRequest<SessionImageList>(`/api/agent-sessions/${sessionId}/images?offset=${pageParam}&limit=20`, { signal }),
    getNextPageParam: page => page.offset + page.images.length < page.total && page.images.length ? page.offset + page.images.length : undefined,
    enabled: open, retry: false
  });
  return <details className={styles.gallery} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>会话图片（{count}）</summary>
    {open && <>
      {query.isPending && <p role="status">正在读取图片列表…</p>}
      {query.isError && <p role="alert">图片列表加载失败：{message(query.error)} <button type="button" onClick={() => void query.refetch()}>重试</button></p>}
      {query.data?.pages.flatMap(page => page.images).map(image => <article className={styles.item} key={image.id}>
        <button type="button" aria-expanded={selected === image.id} onClick={() => setSelected(selected === image.id ? null : image.id)}>第 {image.record} 条记录 · 图片 {image.index + 1}</button>
        {image.text && <p>{image.text}</p>}
        {selected === image.id && <ImagePreview sessionId={sessionId} image={image} />}
      </article>)}
      {query.hasNextPage && <button type="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>更多图片</button>}
    </>}
  </details>;
}
