import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiRequest, hasSessionToken } from '../api/client.js';
import { DeviceConnectionGuide } from './DeviceConnectionGuide.js';
import { renderMessages } from '../components/historyView.js';
import type { HistoryMessage, Session, Task, TaskCenterData } from '../../../shared/taskTypes.js';

type Route = 'inbox' | 'devices' | null;
interface SessionPage { messages: HistoryMessage[]; total: number; session?: { partial?: boolean } }
const snapshotKey = ['task-center', 'snapshot'] as const;
const route = (): Route => location.pathname === '/inbox' || location.hash === '#inbox' ? 'inbox' : location.pathname === '/devices' || location.hash === '#devices' ? 'devices' : null;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未知';

function Transcript({ messages }: { messages: HistoryMessage[] }) {
  const host = useRef<HTMLDivElement>(null);
  const previous = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!host.current) return;
    const html = renderMessages(messages);
    if (previous.current !== html) { host.current.innerHTML = html; previous.current = html; }
  }, [messages]);
  return <div className="history-messages" ref={host} />;
}

export function SessionRecords({ session }: { session: Session }) {
  const local = session.deviceId === 'local' && (!['codexExecution', 'agentExecution'].includes(session.source || '') || Boolean(session.historyId));
  const records = useInfiniteQuery({
    queryKey: ['task-center', 'session', session.id],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => apiRequest<SessionPage>(`/api/agent-sessions/${encodeURIComponent(session.historyId || session.id)}?limit=100&offset=${pageParam}`, { signal }),
    getNextPageParam: (lastPage, pages) => {
      const count = pages.reduce((sum, page) => sum + page.messages.length, 0);
      return count < lastPage.total && lastPage.messages.length ? count : undefined;
    },
    enabled: local && !session.missing,
    staleTime: 30_000,
    retry: false
  });
  if (session.missing) return <p>原始记录暂不可用，任务关联仍保留。</p>;
  if (!local) return <><Transcript messages={[{ role: 'assistant', text: session.excerpt || '尚未同步文本，请在目标设备查看。' }]} /><p className="tc-meta">连接器同步的片段 · 非完整历史</p></>;
  if (records.isPending) return <p role="status">正在读取原始会话…</p>;
  if (records.isError) return <p role="alert">{errorMessage(records.error)} <button className="button secondary" type="button" onClick={() => void records.refetch()}>重试读取</button></p>;
  const messages = records.data.pages.flatMap(page => page.messages);
  const latest = records.data.pages.at(-1)!;
  return <><Transcript messages={messages} /><p className="tc-meta">已显示 {messages.length} / {latest.total} 条记录{latest.session?.partial ? ' · 部分记录' : ''}</p>
    {records.hasNextPage && <button className="button secondary" type="button" disabled={records.isFetchingNextPage} onClick={() => void records.fetchNextPage()}>加载更多记录</button>}
  </>;
}

function InboxSession({ session, data, canEdit, refresh }: { session: Session; data: TaskCenterData; canEdit: boolean; refresh(): void }) {
  const [open, setOpen] = useState(false);
  const [linking, setLinking] = useState(false);
  const [taskId, setTaskId] = useState('');
  const [error, setError] = useState('');
  const device = data.devices.find(item => item.id === session.deviceId);
  const position = `${device?.name || '未知设备'} / ${session.agentLabel || session.agent || '未知 Agent'}`;
  const link = useMutation({
    retry: false,
    mutationFn: (task: Task) => apiRequest<{ taskId: string }>('/api/task-center', { method: 'POST', body: JSON.stringify({ action: 'link', taskId: task.id, revision: task.revision, sessionId: session.id }) }),
    onSuccess: result => {
      setError(''); setLinking(false); refresh();
      window.dispatchEvent(new CustomEvent('bugflow:open-task', { detail: { taskId: result.taskId, source: 'session' } }));
    },
    onError: (failure) => { setError(errorMessage(failure)); refresh(); }
  });
  return <article className="tc-session">
    <details className="tc-session-thread" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><strong>{session.title}</strong><span className="tc-meta">{position} · {time(session.updatedAt)}{device?.online === false ? ' · 设备离线' : ''}{session.partial ? ' · 部分记录' : ''}</span></summary>
      <div className="tc-thread-content">{open && <SessionRecords session={session} />}</div>
    </details>
    {canEdit && <div className="tc-actions"><button className="button secondary" type="button" onClick={() => { setLinking(value => !value); setError(''); }}>关联任务</button></div>}
    {linking && <form className="tc-composer" aria-label="关联会话" onSubmit={event => {
      event.preventDefault();
      const task = data.tasks.find(item => item.id === taskId);
      if (!task) { setError('请选择任务'); return; }
      setError(''); link.mutate(task);
    }}>
      <label>选择已有任务<select value={taskId} onChange={event => setTaskId(event.target.value)} required><option value="">请选择任务</option>{data.tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
      <div className="tc-actions"><button className="button primary" type="submit" disabled={link.isPending || !taskId}>关联任务</button>
        <button className="button secondary" type="button" disabled={link.isPending} onClick={() => window.dispatchEvent(new CustomEvent('bugflow:create-task-from-session', { detail: { sessionId: session.id } }))}>用此会话创建任务</button>
        <button className="button ghost" type="button" disabled={link.isPending} onClick={() => setLinking(false)}>取消</button></div>
      {error && <p role="alert">{error}</p>}
    </form>}
  </article>;
}

export function TaskAuxPage() {
  const [view, setView] = useState(route);
  const [search, setSearch] = useState('');
  const client = useQueryClient();
  useEffect(() => {
    const update = () => setView(route());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const snapshot = useQuery({
    queryKey: snapshotKey,
    queryFn: ({ signal }) => apiRequest<TaskCenterData>('/api/task-center', { signal }),
    enabled: Boolean(view) && hasSessionToken(),
    refetchInterval: view ? 3000 : false,
    refetchIntervalInBackground: false
  });
  const identity = useQuery({
    queryKey: ['task-center', 'identity'],
    queryFn: ({ signal }) => apiRequest<{ permissions: string[]; user?: { username: string }; tenant?: { id: string } }>('/api/bootstrap', { signal }),
    enabled: Boolean(view) && hasSessionToken()
  });
  if (!view) return null;
  const data = snapshot.data;
  const unassigned = data?.sessions.filter(session => !data.tasks.some(task => task.sessionIds.includes(session.id))) || [];
  const needle = search.trim().toLowerCase();
  const visible = unassigned.filter(session => !needle || [session.title, session.agent, session.cwd, data?.devices.find(device => device.id === session.deviceId)?.name].join(' ').toLowerCase().includes(needle));
  const refresh = () => { void client.invalidateQueries({ queryKey: snapshotKey }); };
  return <>
    <header className="tc-heading"><div><p className="eyebrow">跨设备 · 跨 Agent</p><h1>任务中心</h1></div><div className="tc-actions"><button className="button secondary" type="button" disabled={snapshot.isFetching} onClick={() => void snapshot.refetch()}>刷新</button></div></header>
    <nav className="tc-nav" aria-label="任务中心视图"><a href="#tasks" aria-current={view === null ? 'page' : undefined}>全部任务<span>{data?.tasks.length || 0}</span></a>
      <a href="#inbox" aria-current={view === 'inbox' ? 'page' : undefined}>未归属会话<span>{unassigned.length}</span></a>
      <a href="#devices" aria-current={view === 'devices' ? 'page' : undefined}>设备与 Agent<span>{data?.devices.length || 0}</span></a></nav>
    {snapshot.isPending ? <p role="status">正在汇总任务与会话…</p> : snapshot.isError ? <p role="alert">加载失败：{errorMessage(snapshot.error)} <button className="button secondary" type="button" onClick={() => void snapshot.refetch()}>重试</button></p> : data && (view === 'devices' ?
      <section className="tc-devices">{data.devices.map(device => <article key={device.id}><div className="tc-actions"><h2>{device.name}</h2><span className="tc-tag">{device.online ? '在线' : '离线'}</span></div>
        <p>{device.agents.join(' · ') || '未发现 Agent'}</p><p className="tc-meta">{device.transport === 'manual' ? '工作台所在设备' : `连接器 · 最近心跳 ${time(device.lastSeen)}`}</p>
        {device.transport === 'connector' && <><p>{device.codexProjects?.length ? `可远程执行 · ${device.codexProjects.length} 个项目` : '仅同步 · 未提供可执行项目'}{device.capabilities?.resumeCodex ? ' · 支持 Codex 原会话续聊' : ''}</p>
          {device.codexProjects?.map(project => <p className="tc-meta" key={project.id}>{project.name} · {project.cwd}</p>)}
          {!device.online && <p className="tc-callout">设备离线，已提交的任务会等待重新连接；执行结果未知时请先核对。</p>}
          {!!device.codexProjects?.length && identity.data?.permissions.includes('work.execute') && <a className="button secondary" href={`/tasks/new?deviceId=${encodeURIComponent(device.id)}`}>新建远端任务</a>}</>}
        </article>)}
        {identity.data?.permissions.includes('work.execute') ? <DeviceConnectionGuide username={identity.data.user?.username} /> : <article><h2>连接本机 Agent</h2><p>当前账号没有接入设备和远程执行任务的权限。</p></article>}
      </section> : <section className="tc-inbox"><div className="tc-actions"><h2>未归属会话</h2><label className="tc-search">搜索会话<input value={search} onChange={event => setSearch(event.target.value)} placeholder="任务名、Agent 或工作目录" maxLength={200} /></label></div>
        <p className="tc-meta">自动汇总的历史记录需要手动关联任务；远端设备需运行同步连接器。</p>
        {visible.length ? visible.map(session => <InboxSession key={session.id} session={session} data={data} canEdit={identity.data?.permissions.includes('work.execute') === true} refresh={refresh} />)
          : <div className="tc-empty"><h2>暂无匹配会话</h2><p>可以调整搜索条件，或连接其他设备后刷新。</p></div>}
      </section>)}
  </>;
}
