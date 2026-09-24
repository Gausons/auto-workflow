import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiRequest, hasSessionToken } from '../api/client.js';
import { createHistoryComposer } from '../../../public/historyComposer.js';
import { renderMessages } from '../../../public/historyView.js';
import type { HistoryMessage, Session } from '../../../public/taskTypes.js';

interface HistorySession extends Session { createdAt: string; messageCount: number }
interface HistoryDetailResponse { session: HistorySession; messages: HistoryMessage[]; total: number; inherited?: { count: number; partial?: boolean } }
interface HistoryProvider { id: string; label: string; status: string; skipped?: number }
interface HistoryWorkspace { path: string; count: number }
interface HistoryListResponse {
  offset: number; limit: number; total: number; scope: string; providers: HistoryProvider[];
  workspaces: HistoryWorkspace[]; sessions: HistorySession[];
}
interface HistoryFilters { offset: number; agent: string; query: string; workspace: string }
interface InheritedPage { messages: HistoryMessage[]; total: number }
interface ComposerHandlers {
  canEdit(): boolean;
  refresh(id: string): void;
  syncHistory(id: string): Promise<HistoryMessage[] | null>;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const statusLabels: Record<string, string> = { ready: '等待输入', preparing: '正在准备上下文', queued: '等待执行', launching: '正在连接', running: '正在回复', waiting: '等待处理', failed: '执行失败', completed: '本轮结束', interrupted: '已中断', error: '发生错误', unknown: '运行状态未知' };
const sourceLabels: Record<string, string> = { available: '可读取', missing: '未找到历史目录', unconfigured: '未配置', error: '无法读取目录' };
const statusLabel = (value: unknown) => statusLabels[String(value)] || '运行状态未知';
const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '时间未知';
const directoryName = (value: string | undefined) => value?.split('/').filter(Boolean).at(-1) || '未知工作区';
const currentRoute = () => ({ active: /^#history(?:\/|$)/.test(location.hash), id: /^#history\/([a-f0-9]{64})$/.exec(location.hash)?.[1] || null });

function SafeMessages({ messages }: { messages: HistoryMessage[] }) {
  const element = useRef<HTMLDivElement>(null);
  const rendered = useRef<string | null>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const scroll = node.closest<HTMLElement>('.history-chat-scroll');
    const follow = scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
    const html = renderMessages(messages);
    if (rendered.current !== html) { node.innerHTML = html; rendered.current = html; }
    if (follow && scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [messages]);
  return <div className="history-messages" data-history-transcript ref={element} />;
}

function HistoryDetail({ id, canExecute, composer, handlers }: { id: string; canExecute: boolean; composer: ReturnType<typeof createHistoryComposer>; handlers: { current: ComposerHandlers | null } }) {
  const composerHost = useRef<HTMLElement>(null);
  const outputHost = useRef<HTMLDivElement>(null);
  const [synced, setSynced] = useState<{ messages: HistoryMessage[]; total: number } | null>(null);
  const detail = useInfiniteQuery({
    queryKey: ['history', 'detail', id],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => apiRequest<HistoryDetailResponse>(`/api/agent-sessions/${encodeURIComponent(id)}?offset=${pageParam}&limit=100`, { signal }),
    getNextPageParam: (lastPage, pages) => {
      const count = pages.reduce((total, page) => total + page.messages.length, 0);
      return count < lastPage.total && lastPage.messages.length ? count : undefined;
    }
  });
  const inherited = useInfiniteQuery({
    queryKey: ['history', 'inherited', id],
    initialPageParam: 0,
    enabled: false,
    queryFn: ({ pageParam, signal }) => apiRequest<InheritedPage>(`/api/conversations/${encodeURIComponent(id)}/inherited?offset=${pageParam}`, { signal }),
    getNextPageParam: (lastPage, pages) => {
      const count = pages.reduce((total, page) => total + page.messages.length, 0);
      return count < lastPage.total && lastPage.messages.length ? count : undefined;
    }
  });
  const first = detail.data?.pages[0];
  const session = first?.session;
  const loadedMessages = detail.data?.pages.flatMap(page => page.messages) || [];
  const messages = synced?.messages || loadedMessages;

  useEffect(() => {
    if (!session || !composerHost.current || !outputHost.current) return;
    let alive = true;
    const controller = new AbortController();
    handlers.current = {
      canEdit: () => canExecute,
      refresh: () => { setSynced(null); void detail.refetch(); },
      syncHistory: async currentId => {
        const all: HistoryMessage[] = [];
        let page: HistoryDetailResponse;
        do {
          page = await apiRequest<HistoryDetailResponse>(`/api/agent-sessions/${encodeURIComponent(currentId)}?offset=${all.length}&limit=200`, { signal: controller.signal });
          all.push(...page.messages);
        } while (all.length < page.total && page.messages.length);
        if (!alive) return null;
        setSynced({ messages: all, total: page.total });
        return all;
      }
    };
    composer.mount(composerHost.current, session, outputHost.current, loadedMessages);
    return () => { alive = false; controller.abort(); composer.unmount(); handlers.current = null; };
  }, [session?.id, canExecute]);

  if (detail.isPending) return <div className="history-detail" role="status">正在读取会话…</div>;
  if (detail.isError || !first || !session) return <div className="history-detail" role="alert">加载失败：{errorMessage(detail.error)} <button className="button secondary" type="button" onClick={() => detail.refetch()}>重试</button></div>;
  const duration = Math.max(0, Date.parse(session.updatedAt) - Date.parse(session.createdAt));
  const durationText = Number.isFinite(duration) ? `${Math.floor(duration / 60000)} 分钟 ${Math.floor(duration / 1000) % 60} 秒` : '未知';
  const canContinue = canExecute && !session.archived && (session.managed || (session.agent === 'codex' && (!session.deviceId || session.deviceId === 'local')));
  const inheritedMessages = inherited.data?.pages.flatMap(page => page.messages) || [];
  const inheritedTotal = inherited.data?.pages.at(-1)?.total ?? first.inherited?.count ?? 0;

  return <div className="history-detail" aria-live="polite">
    <header className="history-chat-header"><div><h2>{session.title}</h2><span>{session.agentLabel} · {directoryName(session.cwd)}</span></div><span className="history-readonly">{canContinue ? '可续聊' : '只读'}</span></header>
    <div className="history-chat-scroll"><div className="history-chat-content">
      <details className="history-session-info"><summary>会话跨度 {durationText}<span>›</span></summary><dl className="history-info">
        <dt>会话 ID</dt><dd>{session.sessionId || session.id}</dd><dt>工作目录</dt><dd>{session.workspaces?.join('、') || session.cwd || '未知'}</dd>
        <dt>模型 / 分支</dt><dd>{session.model || '未知'} / {session.branch || '未知'}</dd><dt>记录状态</dt><dd>{statusLabel(session.status)}</dd>
        <dt>创建 / 更新</dt><dd>{time(session.createdAt)} / {time(session.updatedAt)}</dd>
      </dl></details>
      {session.partial && <p className="history-warning">部分记录损坏、尚未写完或超出读取上限，当前展示部分内容。</p>}
      {first.inherited && <details className="history-inherited"><summary>接续自原会话 · {first.inherited.count} 条上下文{first.inherited.partial ? ' · 部分记录' : ''}</summary>
        {inheritedMessages.length > 0 && <SafeMessages messages={inheritedMessages} />}
        {inherited.isError && <p role="alert">{errorMessage(inherited.error)}</p>}
        {inheritedMessages.length < inheritedTotal && <button type="button" className="button secondary" disabled={inherited.isFetching} onClick={() => void (inherited.data ? inherited.fetchNextPage() : inherited.refetch())}>{inheritedMessages.length ? '加载更多继承记录' : '查看继承记录'}</button>}
      </details>}
      <SafeMessages messages={messages} />
      <div className="history-chat-footer"><span>已显示 {messages.length} / {synced?.total ?? first.total} 条记录</span>{!synced && detail.hasNextPage && <button className="button secondary" type="button" disabled={detail.isFetchingNextPage} onClick={() => void detail.fetchNextPage()}>加载更多记录</button>}</div>
      <div id="historyLiveOutput" className="history-messages" role="log" aria-live="polite" ref={outputHost} />
    </div></div>
    <section className="history-composer" id="historyComposer" aria-label="会话输入框" ref={composerHost} />
  </div>;
}

export function HistoryPage() {
  const [route, setRoute] = useState(currentRoute);
  const [filters, setFilters] = useState<HistoryFilters>({ offset: 0, agent: '', query: '', workspace: '' });
  const [draft, setDraft] = useState('');
  const composerHandlers = useRef<ComposerHandlers | null>(null);
  const composerRef = useRef<ReturnType<typeof createHistoryComposer> | null>(null);
  if (!composerRef.current) composerRef.current = createHistoryComposer({
    api: (path, init) => apiRequest(path, init),
    canEdit: () => composerHandlers.current?.canEdit() ?? false,
    refresh: id => composerHandlers.current?.refresh(id),
    syncHistory: id => composerHandlers.current?.syncHistory(id) ?? Promise.resolve(null),
    openSession: id => { location.hash = `history/${id}`; }
  });
  useEffect(() => {
    const update = () => setRoute(currentRoute());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const list = useQuery({
    queryKey: ['history', 'list', filters],
    queryFn: ({ signal }) => apiRequest<HistoryListResponse>(`/api/agent-sessions?${new URLSearchParams({ offset: String(filters.offset), limit: '30', agent: filters.agent, q: filters.query, workspace: filters.workspace })}`, { signal }),
    enabled: route.active && hasSessionToken(),
    refetchOnWindowFocus: false
  });
  const identity = useQuery({
    queryKey: ['history', 'identity'],
    queryFn: ({ signal }) => apiRequest<{ permissions: string[] }>('/api/bootstrap', { signal }),
    enabled: route.active && hasSessionToken(),
    refetchOnWindowFocus: false
  });
  if (!route.active) return null;
  const data = list.data;
  const changeFilters = (next: Partial<HistoryFilters>) => {
    setFilters(previous => ({ ...previous, ...next, offset: 0 }));
    if (route.id) location.hash = 'history';
  };
  const sourceText = data && `${data.scope === 'all' ? '全部本地工作区' : '仅组织工作目录'} · ${data.providers.map(provider => `${provider.label}：${sourceLabels[provider.status] || provider.status}${provider.skipped ? `（${provider.skipped} 项未能读取）` : ''}`).join(' · ')}`;
  const workspaceOptions = data?.workspaces || [];
  return <>
    <div className="history-heading"><h1>会话</h1><span>Agent 历史记录</span></div>
    <div className="history-layout">
      <aside className="history-browser" aria-label="历史会话列表">
        <form className="history-filters" onSubmit={event => {
          event.preventDefault();
          const query = draft.trim();
          if (query === filters.query && filters.offset === 0) void list.refetch();
          else changeFilters({ query });
        }}>
          <label className="history-search">搜索会话<input value={draft} onChange={event => setDraft(event.target.value)} placeholder="搜索会话…" maxLength={200} /></label>
          <div className="history-selects">
            <label>Agent<select value={filters.agent} onChange={event => changeFilters({ agent: event.target.value })}><option value="">全部 Agent</option>{data?.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
            <label>工作区<select value={filters.workspace} onChange={event => changeFilters({ workspace: event.target.value })}><option value="">全部工作区</option>{workspaceOptions.map(workspace => <option key={workspace.path} value={workspace.path}>{workspace.path === '__unknown__' ? '未知工作区' : workspace.path} ({workspace.count})</option>)}{filters.workspace && !workspaceOptions.some(item => item.path === filters.workspace) && <option value={filters.workspace}>{filters.workspace} (0)</option>}</select></label>
          </div>
          <button className="button secondary" type="submit">刷新会话</button>
        </form>
        <p role={list.isError ? 'alert' : 'status'} aria-live="polite">{list.isPending ? '正在读取历史会话，首次索引可能需要一些时间…' : list.isError ? `加载失败：${errorMessage(list.error)}` : data?.total ? `共 ${data.total} 个会话，按最近更新时间排序` : '没有匹配的会话，试试其他工作区或搜索词。'}</p>
        {list.isError && <button className="button secondary" type="button" onClick={() => list.refetch()}>重试</button>}
        <div className="history-list">{data?.sessions.map(session => <button className="history-card" type="button" key={session.id} aria-pressed={session.id === route.id} onClick={() => { location.hash = `history/${session.id}`; }}>
          <strong>{session.title}</strong><span className="history-meta">{session.agentLabel} · {time(session.updatedAt)}</span>
          <span>{statusLabel(session.status)} · {session.messageCount} 条记录{session.managed ? ' · 已继承上下文' : ''}{session.archived ? ' · 已归档' : ''}{session.partial ? ' · 部分记录' : ''}</span>
          <span className="history-meta">{directoryName(session.cwd)}{session.branch ? ` · ${session.branch}` : ''}</span>
        </button>)}</div>
        <div className="history-pagination"><button className="button secondary" type="button" disabled={!data || data.offset === 0} aria-label="上一页" onClick={() => setFilters(previous => ({ ...previous, offset: Math.max(0, previous.offset - 30) }))}>←</button>
          <span>{data?.total ? `${data.offset + 1}–${Math.min(data.offset + data.limit, data.total)} / ${data.total}` : '0 / 0'}</span>
          <button className="button secondary" type="button" disabled={!data || data.offset + data.limit >= data.total} aria-label="下一页" onClick={() => setFilters(previous => ({ ...previous, offset: previous.offset + 30 }))}>→</button></div>
        <details className="history-source-details"><summary>数据来源</summary><p className="history-meta">{sourceText}</p></details>
      </aside>
      {route.id ? <HistoryDetail key={route.id} id={route.id} canExecute={identity.data?.permissions.includes('work.execute') === true} composer={composerRef.current} handlers={composerHandlers} /> : <div className="history-detail" aria-live="polite"><div className="history-empty"><span>◎</span><h2>从一个会话开始</h2><p>选择历史会话，查看对话与工作过程</p></div></div>}
    </div>
  </>;
}
