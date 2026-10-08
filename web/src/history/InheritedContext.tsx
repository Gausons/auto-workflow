import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContextPreviewResponse, InheritedContextInfo } from '../../../shared/contextPreviewTypes.js';
import { apiRequest } from '../api/client.js';
import { renderMessages } from '../components/historyView.js';
import styles from './InheritedContext.module.css';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const roleLabel = (role: string) => ({ user: '用户', assistant: '助手', tool_call: '工具调用', tool_result: '工具结果', reference: '任务参考' })[role] || '历史记录';
interface Props { id: string; info: InheritedContextInfo }

function ContextDrawer({ preview, sourceTitle, close }: { preview: ReturnType<typeof usePreview>; sourceTitle: string; close(): void }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const messages = preview.data?.pages.flatMap(page => page.messages) || [];
  return createPortal(<div className={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div className={styles.drawer} ref={panel} role="dialog" aria-modal="true" aria-label="继承上下文明细" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab') return;
      const focusable = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, [tabindex="0"]') || [])].filter(element => element.getClientRects().length > 0);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header className={styles.drawerHeader}><div><h2>继承上下文明细</h2><p>{sourceTitle} · 历史参考资料</p></div><button ref={closeButton} type="button" className="button secondary" onClick={close}>关闭明细</button></header>
      <div className={styles.transcript}>
        {messages.map(message => <section className={styles.record} key={message.record} aria-label={`记录 ${message.record}`}>
          <div className={styles.origin}>记录 {message.record} · {roleLabel(message.role)} · {message.source}{message.line ? ` · 第 ${message.line} 行` : ''}</div>
          <div dangerouslySetInnerHTML={{ __html: renderMessages([message]) }} />
        </section>)}
        {preview.isError && <p role="alert">加载失败：{errorMessage(preview.error)}</p>}
      </div>
      <footer className={styles.drawerFooter}><span>已显示 {messages.length} / {preview.data?.pages[0]?.total ?? 0} 条可预览记录</span>
        {preview.isError ? <button className="button secondary" type="button" disabled={preview.isFetching} onClick={() => void (preview.isFetchNextPageError ? preview.fetchNextPage() : preview.refetch())}>重试加载明细</button>
          : preview.hasNextPage && <button className="button secondary" type="button" disabled={preview.isFetchingNextPage} onClick={() => void preview.fetchNextPage()}>{preview.isFetchingNextPage ? '正在加载…' : '加载更多记录'}</button>}
      </footer>
    </div>
  </div>, document.body);
}

function usePreview(id: string, info: InheritedContextInfo, expanded: boolean) {
  return useInfiniteQuery({
    queryKey: ['history', 'context-preview', id, info.digest, info.briefId, info.availability, info.count, info.coverage?.records],
    initialPageParam: 0,
    enabled: expanded && info.availability !== 'pending',
    queryFn: ({ pageParam, signal }) => apiRequest<ContextPreviewResponse>(`/api/conversations/${encodeURIComponent(id)}/context-preview?offset=${pageParam}`, { signal }),
    getNextPageParam: lastPage => lastPage.nextOffset ?? undefined,
    refetchOnWindowFocus: false
  });
}

function ContextCard({ id, info }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const preview = usePreview(id, info, expanded);
  const first = preview.data?.pages[0];
  const remote = info.availability === 'remote';
  const pending = info.availability === 'pending';
  const title = info.sourceTitle || '原会话';
  const sourceLink = info.sourceSessionId && /^[a-f0-9]{64}$/.test(info.sourceSessionId) ? `#history/${info.sourceSessionId}` : undefined;
  const status = pending ? '正在准备上下文' : remote ? info.coverage ? '来源设备已准备上下文' : '上下文在来源设备，实际携带量待回报' : '上下文已准备';
  const scope = info.coverage ? `${info.coverage.records} 条记录 · ${info.coverage.images} 张图片` : remote || pending ? '完整记录数量待确认' : `${info.count} 条记录`;
  return <>
    <section className={styles.card} aria-label="继承上下文">
      <button className={styles.toggle} type="button" aria-expanded={expanded} aria-controls={`inherited-${id}`} onClick={() => { setExpanded(value => !value); setShowDetails(false); }}>
        <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`} aria-hidden="true">›</span><span className={styles.heading}><strong>接续自 {title}</strong><span className={styles.status}>{status} · {scope}</span></span>
      </button>
      {expanded && <div className={styles.body} id={`inherited-${id}`}>
        <p className={styles.source}>来源：{sourceLink ? <a href={sourceLink}>{title}</a> : title}</p>
        <p className={styles.scope}>继承内容仅作历史参考。代码仓库和普通附件文件需在目标设备另行准备。</p>
        {((!remote && info.partial) || info.coverage?.partial) && <p className={styles.warning}>来源记录不完整，缺失细节需回到原会话核对。</p>}
        {remote && <p className={styles.warning}>{info.coverage ? `来源设备已准备 ${info.coverage.records} 条记录、${info.coverage.images} 张原始图片。` : '首次发送时将由来源设备读取完整上下文。'}工作台仅能预览已保存的摘要，以下数量不代表实际携带量。</p>}
        {pending ? <p role="status">等待来源会话本轮结束后准备上下文。</p> : preview.isPending ? <p role="status">正在读取上下文概览…</p> : preview.isError && !first ? <p role="alert">加载失败：{errorMessage(preview.error)} <button className="button secondary" type="button" onClick={() => void preview.refetch()}>重试读取上下文</button></p> : first && <>
          <p className={styles.scope}>可预览 {first.total} 条：{first.stats.users} 条用户消息 · {first.stats.assistants} 条助手回复 · {first.stats.tools} 条工具记录{first.stats.references ? ` · ${first.stats.references} 条参考资料` : ''} · {first.stats.images} 张图片</p>
          {first.stats.unavailableImages > 0 && <p className={styles.warning}>{first.stats.unavailableImages} 张图片无法在此预览，明细中保留原因。</p>}
          {first.stats.truncatedMessages > 0 && <p className={styles.warning}>{first.stats.truncatedMessages} 条长记录仅展示节选，完整原文仍保留在交接记录中。</p>}
          {first.stats.unsupportedBlocks > 0 && <p className={styles.warning}>{first.stats.unsupportedBlocks} 项内容暂不支持预览，完整原文仍保留在交接记录中。</p>}
          {first.brief && <section aria-label="本次交接单">
            <h3 className={styles.excerptHeading}>本次交接单</h3>
            <p className={styles.scope}>以下内容与首次发送时准备的核心交接单一致，不表示 Agent 已阅读或验证。记录编号对应实际交接快照。</p>
            <pre className={styles.brief}>{first.brief.text}</pre>
          </section>}
          <h3 className={styles.excerptHeading}>原文摘录</h3>
          {first.excerpts.length ? first.excerpts.map(excerpt => <blockquote className={styles.excerpt} key={excerpt.record}><span>记录 {excerpt.record} · {roleLabel(excerpt.role)}</span><p>{excerpt.text}</p></blockquote>) : <p>没有可摘录的文本，请查看明细中的图片或工具记录。</p>}
          <div className={styles.actions}><button className="button secondary" type="button" onClick={() => setShowDetails(true)}>查看上下文明细</button><span className={styles.scope}>摘录保留来源顺序，不代表已验证结论</span></div>
        </>}
      </div>}
    </section>
    <div className={styles.divider}>新会话从这里开始</div>
    {showDetails && <ContextDrawer preview={preview} sourceTitle={title} close={() => setShowDetails(false)} />}
  </>;
}

export function InheritedContext(props: Props) {
  return <ContextCard key={props.id} {...props} />;
}
