import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { apiRequest, hasSessionToken } from '../api/client.js';
import { renderMarkdown } from '../components/historyView.js';
import { taskActivity, taskTimeline } from './taskTimeline.js';
import { useTaskCenterUpdates } from './taskCenterUpdates.js';
import { taskContent } from '../../../shared/taskContent.js';
import type { AgentProject, Execution, Handoff, Session, Task, TaskCenterData } from '../../../shared/taskTypes.js';
import { SessionRecords } from './TaskAuxPage.js';
import overlayStyles from '../styles/Overlay.module.css';

type Dialog = { kind: 'edit' | 'execute' | 'handoff' | 'unlink' | 'move' | 'respond' | 'packet' | 'failed' | 'started'; id?: string } | null;
interface Targets { projects: AgentProject[]; localError?: string }
interface DirectoryResult { status: 'pending' | 'selecting' | 'completed' | 'cancelled' | 'failed'; requestId: string; cwd?: string; message?: string }
const labels: Record<string, string> = { waiting: '等待输入', error: '执行异常', running: '进行中', ready: '待接续', review: '待验收', completed: '已完成' };
const handoffLabels: Record<string, string> = { pending: '待接收', received: '已接收 · 待执行', started: '已开始执行', cancelled: '已取消', failed: '失败' };
const executionLabels: Record<string, string> = { blocked: '会话被占用 · 未发送', queued: '等待执行', launching: '正在创建会话', running: 'Agent 执行中', waiting: '等待你处理', completed: '本轮已完成', interrupted: '已停止', failed: '执行失败', unknown: '结果待核对' };
const modeLabels: Record<string, string> = { continue: '接着做', branch: '另开分支', reference: '引用信息' };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未知';
const route = () => location.pathname === '/tasks' || location.hash === '#tasks';
let requestedTaskId: string | null = null;
export function rememberTask(id: string) { requestedTaskId = id; }

function SafeMarkdown({ content, className = '' }: { content: string; className?: string }) {
  const host = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (host.current) host.current.innerHTML = renderMarkdown(content); }, [content]);
  return <section ref={host} className={`history-markdown ${className}`} />;
}

function Overlay({ title, children, onClose, onSubmit, busy, error, submitLabel = '确认' }: { title: string; children: ReactNode; onClose(): void; onSubmit?: (form: FormData) => void; busy: boolean; error: string; submitLabel?: string }) {
  return <div className={overlayStyles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div className={`tc-dialog ${overlayStyles.panel}`} role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); onSubmit?.(new FormData(event.currentTarget)); }}><header className="tc-actions"><h2>{title}</h2><button className="button secondary" type="button" disabled={busy} onClick={onClose}>关闭</button></header>{children}
      {error && <p role="alert" className="tc-form-error">{error}</p>}
      {onSubmit && <footer><button className="button primary" type="submit" disabled={busy}>{submitLabel}</button></footer>}
    </form>
  </div></div>;
}

function packetText(handoff: Handoff, data: TaskCenterData) {
  const packet = handoff.packet;
  return [`# ${packet.title}`, `目标：${data.devices.find(device => device.id === handoff.deviceId)?.name} / ${handoff.agent}`, `上下文版本：${packet.contextVersion}`, handoff.targetSessionId ? `目标会话：${data.sessions.find(session => session.id === handoff.targetSessionId)?.nativeId || handoff.targetSessionId}` : '', taskContent(packet), `## 下一位 Agent 的指令\n${packet.instruction}`, '## 来源', ...packet.sources.map(source => `${source.title} · ${source.agent} · ${source.nativeId}\n${source.cwd}\n${source.excerpt || '仅包含来源索引，可回到工作台查看原始记录。'}`), packet.limitations].join('\n\n');
}

function ExecutionCard({ job, canEdit, open, act, busy }: { job: Execution; canEdit: boolean; open(dialog: Dialog): void; act(action: string, id: string): void; busy: boolean }) {
  const codexThreadId = job.threadId || (job.agent === 'codex' ? job.sessionId : null);
  const releaseLabels: Record<string, string> = { releasing: '正在释放网页连接…', released: '网页连接已释放', failed: '会话释放失败，请检查服务进程' };
  return <article className="tc-execution"><div className="tc-actions"><strong>{executionLabels[job.status] || job.status}</strong><span className="tc-meta">{time(job.createdAt)}</span></div>
    {['failed', 'blocked', 'unknown', 'waiting', 'interrupted'].includes(job.status) && job.message && <p>{job.message}</p>}
    <details className="tc-execution-details"><summary>执行详情</summary>{job.desktopMessage && <p className="tc-meta">{job.desktopMessage}</p>}{job.controlError && <p role="alert">{job.controlError}</p>}{job.releaseStatus && <p className="tc-meta">{releaseLabels[job.releaseStatus]}</p>}
      {job.deviceId !== 'local' && (job.sessionId || job.threadId) && <p className="tc-meta">目标设备的 Agent 会话：{job.sessionId || job.threadId}</p>}
      <p className="tc-meta">{job.agentLabel || job.agent || 'Agent'} · {String(job.protocol || 'legacy').toUpperCase()} · {job.model || '默认模型'} · {job.reasoningEffort || '默认思考强度'} · {job.cwd} · 上下文 v{job.contextVersion}</p>
    </details><div className="tc-actions">{codexThreadId && job.deviceId === 'local' && <a className="button secondary" href={`codex://threads/${encodeURIComponent(codexThreadId)}`}>在 Codex 中打开 ↗</a>}
      {canEdit && job.status === 'waiting' && job.request && <button className="button primary" type="button" onClick={() => open({ kind: 'respond', id: job.id })}>处理 Agent 请求</button>}
      {canEdit && ['queued', 'running', 'waiting'].includes(job.status) && <button className="button secondary" type="button" disabled={busy} onClick={() => act('stop', job.id)}>{job.status === 'queued' ? '取消等待' : '停止执行'}</button>}
      {canEdit && job.status === 'unknown' && <button className="button secondary" type="button" disabled={busy} onClick={() => act('reconcile', job.id)}>核对执行结果</button>}
    </div>{job.output && <SafeMarkdown content={job.output} className="tc-execution-result" />}</article>;
}

function SessionItem({ session, data, canEdit, open }: { session: Session; data: TaskCenterData; canEdit: boolean; open(dialog: Dialog): void }) {
  const [expanded, setExpanded] = useState(false);
  const device = data.devices.find(item => item.id === session.deviceId);
  return <details className="tc-session-thread" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary><strong>{session.title || '会话来源暂不可用'}</strong><span className="tc-meta">{device?.name || '未知设备'} / {session.agentLabel || session.agent || '未知 Agent'} · {executionLabels[session.status || ''] || '历史会话'}{device?.online === false ? ' · 设备离线' : ''}{session.partial ? ' · 部分记录' : ''}</span></summary>
    <div className="tc-thread-content"><p className="tc-meta">{session.cwd || '未记录工作目录'}{session.sourceSessionId ? ` · 接续自 ${data.sessions.find(value => value.id === session.sourceSessionId)?.title || session.sourceSessionId}` : ''}</p>
      {expanded ? <SessionRecords session={session} /> : session.excerpt ? <pre>{session.excerpt}</pre> : <p className="tc-meta">展开后读取原始会话</p>}
      {canEdit && <div className="tc-actions"><a className="button secondary" href={`#history/${session.historyId || session.id}`}>打开会话 / 切换 Agent</a>{session.source !== 'conversation' && <button className="button secondary" type="button" onClick={() => open({ kind: 'unlink', id: session.id })}>解除关联</button>}<button className="button secondary" type="button" onClick={() => open({ kind: 'move', id: session.id })}>移动到其他任务</button></div>}
    </div>
  </details>;
}

export function TaskPage() {
  const [active, setActive] = useState(route);
  const [selected, setSelected] = useState<string | null>(() => requestedTaskId);
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const queryClient = useQueryClient();
  useEffect(() => { const update = () => setActive(route()); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  useEffect(() => { const open = (event: Event) => { const id = (event as CustomEvent<{ taskId?: string }>).detail?.taskId; if (id) { rememberTask(id); setSelected(id); location.hash = 'tasks'; } }; window.addEventListener('bugflow:open-task', open); return () => window.removeEventListener('bugflow:open-task', open); }, []);
  const snapshot = useQuery({ queryKey: ['task-center', 'snapshot'], queryFn: ({ signal }) => apiRequest<TaskCenterData>('/api/task-center', { signal }), enabled: active && hasSessionToken() });
  useTaskCenterUpdates(active, snapshot.data?.syncVersion);
  const identity = useQuery({ queryKey: ['task-center', 'identity'], queryFn: ({ signal }) => apiRequest<{ permissions: string[] }>('/api/bootstrap', { signal }), enabled: active && hasSessionToken() });
  const targets = useQuery({ queryKey: ['task-center', 'targets'], queryFn: ({ signal }) => apiRequest<Targets>('/api/task-center/codex', { signal }), enabled: active && dialog?.kind === 'execute', retry: false });
  const data = snapshot.data;
  const task = data?.tasks.find(item => item.id === selected) || data?.tasks[0];
  const canEdit = identity.data?.permissions.includes('work.execute') === true;
  const mutate = useMutation({ retry: false, mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) => apiRequest<{ taskId?: string }>(path, { method: 'POST', body: JSON.stringify(body) }), onSuccess: (result, variables) => { if (result.taskId) setSelected(result.taskId); if (variables.path === '/api/task-center/execute') setNotice('已提交 Agent，执行状态将自动更新'); setDialog(null); setError(''); void queryClient.invalidateQueries({ queryKey: ['task-center', 'snapshot'] }); }, onError: failure => { setError(errorMessage(failure)); void queryClient.invalidateQueries({ queryKey: ['task-center', 'snapshot'] }); } });
  const send = (body: Record<string, unknown>, path = '/api/task-center') => { if (!mutate.isPending) mutate.mutate({ path, body }); };
  const open = (value: Dialog) => { setError(''); setDialog(value); };
  const act = (action: string, executionId: string) => send({ executionId, action }, '/api/task-center/execution-action');
  if (!active) return null;
  if (snapshot.isPending) return <p role="status">正在汇总任务与会话…</p>;
  if (snapshot.isError || !data) return <p role="alert">{errorMessage(snapshot.error)} <button className="button secondary" type="button" onClick={() => void snapshot.refetch()}>重试</button></p>;
  const needle = search.trim().toLowerCase();
  const visible = data.tasks.filter(item => !needle || [item.title, taskContent(item), ...data.sessions.filter(session => item.sessionIds.includes(session.id)).flatMap(session => [session.title, session.cwd, session.agent])].join(' ').toLowerCase().includes(needle)).sort((a, b) => Number(b.status === 'waiting') - Number(a.status === 'waiting') || taskActivity(b, data) - taskActivity(a, data));
  const unassigned = data.sessions.filter(session => !data.tasks.some(item => item.sessionIds.includes(session.id)));
  const timeline = task ? taskTimeline(task, data) : [];
  const jobs = task ? data.executions.filter(job => job.taskId === task.id) : [];
  const waiting = jobs.find(job => job.status === 'waiting' && job.request);
  const activeJob = jobs.some(job => ['queued', 'launching', 'running', 'waiting', 'unknown'].includes(job.status));
  return <><header className="tc-heading"><div><p className="eyebrow">跨设备 · 跨 Agent</p><h1>任务中心</h1></div><button className="button secondary" type="button" disabled={snapshot.isFetching} onClick={() => void snapshot.refetch()}>刷新</button></header>
    <nav className="tc-nav" aria-label="任务中心视图"><a href="#tasks" aria-current="page">全部任务<span>{data.tasks.length}</span></a><a href="#inbox">未归属会话<span>{unassigned.length}</span></a><a href="#devices">设备与 Agent<span>{data.devices.length}</span></a></nav>
    <div className="tc-layout"><aside className="tc-list" aria-label="任务列表"><label className="tc-task-search">搜索任务与会话<input value={search} onChange={event => setSearch(event.target.value)} placeholder="任务、会话标题、工作目录" maxLength={200} /></label>{visible.length ? visible.map(item => <button key={item.id} className="tc-task" type="button" aria-pressed={task?.id === item.id} onClick={() => setSelected(item.id)}><strong>{item.title}</strong><span>{labels[item.status] || item.status}</span><small>{time(new Date(taskActivity(item, data)).toISOString())} · {item.sessionIds.length} 段会话</small></button>) : <p className="tc-meta">暂无匹配任务</p>}</aside>
      <div className="tc-detail">{!task ? <div className="tc-empty"><h2>从一件事开始</h2><p>创建任务，或把未归属会话关联到任务。</p></div> : <>
        <header className="tc-detail-head"><div><span className="tc-tag">{labels[task.status] || task.status}</span><h2>{task.title}</h2><p className="tc-meta">{task.sessionIds.length} 段会话 · 最近活动 {time(new Date(taskActivity(task, data)).toISOString())}</p></div>{canEdit && <div className="tc-actions"><button className="button secondary" type="button" onClick={() => open({ kind: 'edit' })}>编辑任务</button><button className="button secondary" type="button" onClick={() => open({ kind: 'handoff' })}>转交 / 分支</button></div>}</header>
        <SafeMarkdown content={taskContent(task)} className="tc-task-content" />
        <div className="tc-actions"><h3>任务时间线</h3>{canEdit && <a className="button secondary" href="#inbox">关联历史会话</a>}</div>
        <div className="tc-timeline">{timeline.map(item => <article className="tc-timeline-item" key={`${item.kind}:${item.id}`}><time className="tc-meta">{time(item.at)}</time>{item.kind === 'session' ? <><SessionItem session={item.value as Session} data={data} canEdit={canEdit} open={open} />{item.jobs.filter(job => job.status !== 'completed').map(job => <ExecutionCard key={job.id} job={job as Execution} canEdit={canEdit} open={open} act={act} busy={mutate.isPending} />)}</> : item.kind === 'execution' ? <ExecutionCard job={item.value as Execution} canEdit={canEdit} open={open} act={act} busy={mutate.isPending} /> : <HandoffCard handoff={item.value as Handoff} data={data} canEdit={canEdit} open={open} send={send} busy={mutate.isPending} />}</article>)}</div>
        <footer className="tc-task-footer tc-actions">{canEdit ? <>{!activeJob && <button className="button secondary" type="button" disabled={mutate.isPending} onClick={() => send({ action: 'update', taskId: task.id, revision: task.revision, content: taskContent(task), status: task.status === 'completed' ? 'ready' : 'completed' })}>{task.status === 'completed' ? '重新打开任务' : '标记任务完成'}</button>}{waiting ? <button className="button primary" type="button" onClick={() => open({ kind: 'respond', id: waiting.id })}>处理待办</button> : !activeJob && task.status !== 'completed' && <button className="button primary" type="button" onClick={() => open({ kind: 'execute' })}>继续任务</button>}</> : <span className="tc-meta">只读</span>}</footer>
      </>}</div></div>
    {notice && <p role="status">{notice}</p>}
    {dialog && task && <TaskDialog dialog={dialog} task={task} data={data} targets={targets.data} targetsError={targets.error} onClose={() => open(null)} send={send} busy={mutate.isPending} error={error} setError={setError} />}
  </>;
}

function HandoffCard({ handoff, data, canEdit, open, send, busy }: { handoff: Handoff; data: TaskCenterData; canEdit: boolean; open(dialog: Dialog): void; send(body: Record<string, unknown>): void; busy: boolean }) {
  const target = data.devices.find(device => device.id === handoff.deviceId);
  return <article className="tc-handoff"><div className="tc-actions"><strong>{modeLabels[handoff.mode]} → {target?.name} / {handoff.agent}</strong><span className="tc-tag">{handoff.mode === 'reference' && handoff.status === 'received' ? '引用已接收' : handoffLabels[handoff.status]}</span></div><p className="tc-meta">{time(handoff.createdAt)} · 上下文 v{handoff.packet.contextVersion}{handoff.mode === 'branch' ? ' · 关联分支' : ''}</p>
    <div className="tc-actions"><button className="button secondary" type="button" onClick={() => open({ kind: 'packet', id: handoff.id })}>查看上下文</button>{canEdit && handoff.status === 'pending' && <button className="button secondary" type="button" disabled={busy} onClick={() => send({ action: 'ack', handoffId: handoff.id, status: 'received', note: '用户手动确认接收' })}>确认已接收</button>}{canEdit && handoff.status === 'received' && handoff.mode !== 'reference' && <button className="button secondary" type="button" onClick={() => open({ kind: 'started', id: handoff.id })}>关联已开始的新会话</button>}{canEdit && ['pending', 'received'].includes(handoff.status) && <><button className="button secondary" type="button" disabled={busy} onClick={() => send({ action: 'ack', handoffId: handoff.id, status: 'cancelled' })}>取消</button><button className="button secondary" type="button" onClick={() => open({ kind: 'failed', id: handoff.id })}>报告失败</button></>}</div>
  </article>;
}

function TaskDialog({ dialog, task, data, targets, targetsError, onClose, send, busy, error, setError }: { dialog: NonNullable<Dialog>; task: Task; data: TaskCenterData; targets?: Targets; targetsError: Error | null; onClose(): void; send(body: Record<string, unknown>, path?: string): void; busy: boolean; error: string; setError(value: string): void }) {
  const [mode, setMode] = useState('continue');
  const [targetIndex, setTargetIndex] = useState(0);
  const [projectIndex, setProjectIndex] = useState(0);
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [picking, setPicking] = useState(false);
  const [copyState, setCopyState] = useState('');
  const handoff = data.handoffs.find(item => item.id === dialog.id);
  const execution = data.executions.find(item => item.id === dialog.id);
  const source = data.sessions.find(item => item.id === dialog.id);
  const destinations = data.devices.flatMap(device => device.agents.map(agent => ({ device, agent })));
  const destination = destinations[targetIndex];
  const project = targets?.projects[projectIndex];
  const selectedModel = project?.models?.find(item => item.id === (model || project.defaultModel));
  const efforts = selectedModel?.reasoningEfforts || project?.reasoningEfforts || [];
  const submit = (event: FormData) => {
    if (busy || picking) return;
    const value = (key: string) => String(event.get(key) || '');
    switch (dialog.kind) {
      case 'edit': send({ action: 'update', taskId: task.id, revision: task.revision, content: value('content'), status: task.status }); return;
      case 'unlink': case 'move': {
        const target = data.tasks.find(item => item.id === value('targetTaskId'));
        send({ action: dialog.kind === 'unlink' ? 'unlink' : 'move', taskId: task.id, revision: task.revision, sessionId: dialog.id, targetTaskId: target?.id || null, targetRevision: target?.revision }); return;
      }
      case 'handoff': {
        if (!destination) { setError('尚未发现可用 Agent，请先连接设备'); return; }
        send({ action: 'handoff', taskId: task.id, revision: task.revision, deviceId: destination.device.id, agent: destination.agent, mode, targetSessionId: value('targetSessionId'), instruction: value('instruction'), includeSources: event.has('includeSources'), includeFiles: true }); return;
      }
      case 'execute': {
        if (!project) { setError('请选择执行目标'); return; }
        send({ taskId: task.id, revision: task.revision, projectId: project.id, cwd: cwd.trim(), model, reasoningEffort: effort, deviceId: project.deviceId, sourceSessionId: value('sourceSessionId'), instruction: value('instruction') }, '/api/task-center/execute');
        return;
      }
      case 'respond': {
        if (!execution?.request) { setError('交互请求不存在'); return; }
        const questions = execution.request.method === 'item/tool/requestUserInput' ? execution.request.params?.questions : undefined;
        send({ executionId: execution.id, action: 'respond', decision: value('decision') || undefined, ...(questions ? { answers: Object.fromEntries(questions.map(question => [question.id, value(`answer-${question.id}`)])) } : {}) }, '/api/task-center/execution-action'); return;
      }
      case 'failed': send({ action: 'ack', handoffId: dialog.id, status: 'failed', note: value('note') }); return;
      case 'started': send({ action: 'ack', handoffId: dialog.id, status: 'started', sessionId: value('sessionId') }); return;
    }
  };
  async function chooseDirectory() {
    if (!project || picking) return;
    setPicking(true); setError('');
    try {
      const response = await apiRequest<DirectoryResult>('/api/task-center/directory-picker', { method: 'POST', body: JSON.stringify({ deviceId: project.deviceId, projectId: project.id }) });
      if (response.status === 'completed') setCwd(response.cwd || '');
      else {
        let completed = false;
        for (let attempt = 0; attempt < 300; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const status = await apiRequest<DirectoryResult>(`/api/task-center/directory-picker?requestId=${encodeURIComponent(response.requestId)}`);
          if (status.status === 'completed') { setCwd(status.cwd || ''); completed = true; break; }
          if (status.status === 'cancelled') throw new Error('已在目标机器取消选择目录');
          if (status.status === 'failed') throw new Error(status.message || '目标机器无法选择目录');
        }
        if (!completed) throw new Error('等待目标机器选择目录超时');
      }
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPicking(false); }
  }
  if (dialog.kind === 'edit') return <Overlay title="编辑任务" onClose={onClose} onSubmit={submit} busy={busy} error={error} submitLabel="保存任务"><label>任务内容 · Markdown<textarea className="tc-markdown-editor" name="content" rows={16} required maxLength={64000} defaultValue={taskContent(task)} /></label></Overlay>;
  if (dialog.kind === 'unlink' || dialog.kind === 'move') return <Overlay title={dialog.kind === 'unlink' ? '解除会话关联' : '移动会话'} onClose={onClose} onSubmit={submit} busy={busy} error={error}><p>{dialog.kind === 'unlink' ? '保留原始会话，解除后可在未归属会话中找到。' : `将「${source?.title || dialog.id}」移动到其他任务。`}</p>{dialog.kind === 'move' && <label>目标任务<select name="targetTaskId" required defaultValue=""><option value="">请选择任务</option>{data.tasks.filter(item => item.id !== task.id).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}</Overlay>;
  if (dialog.kind === 'handoff') {
    const sessions = data.sessions.filter(session => session.deviceId === destination?.device.id && session.agent === destination?.agent);
    return <Overlay title="把任务交给…" onClose={onClose} onSubmit={submit} busy={busy} error={error} submitLabel={mode === 'reference' ? '准备引用' : mode === 'branch' ? '创建分支与交接包' : '保存接续请求'}><div className="tc-two"><label>操作方式<select value={mode} onChange={event => setMode(event.target.value)}><option value="continue">接着做 · 新会话接续</option><option value="branch">另开分支 · 保留原工作</option><option value="reference">引用信息 · 不转交工作</option></select></label><label>执行位置<select value={targetIndex} onChange={event => setTargetIndex(Number(event.target.value))}>{destinations.map((item, index) => <option key={`${item.device.id}:${item.agent}`} value={index}>{item.device.name} / {item.agent} · {item.device.online ? '在线' : '离线'}</option>)}</select></label></div>
      <p className="tc-meta">{mode === 'continue' ? '原会话需先停止或完成当前步骤；目标开始后关联新会话。' : mode === 'branch' ? '创建关联分支任务，原任务继续保留。' : '只传递信息，保留原任务状态。'}</p>
      {mode === 'reference' && <label>引用到哪个会话<select name="targetSessionId" required defaultValue=""><option value="">请选择会话</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label>}
      <h3>携带的信息</h3><p>完整任务 Markdown · 版本 v{task.contextVersion}</p><label className="tc-check"><input type="checkbox" name="includeSources" defaultChecked /> 相关会话来源及已同步片段</label><details><summary>预览任务上下文</summary><SafeMarkdown content={taskContent(task)} /></details><label>给下一位 Agent 的指令<textarea name="instruction" rows={4} required maxLength={12000} defaultValue="继续完成任务。" /></label><p className="tc-callout">{destination?.device.online ? destination.device.transport === 'manual' ? '目标需手动复制交接包。' : '连接器将在下次同步时接收。' : '设备离线，请求将等待重新连接。'} 工作目录、文件版本和权限需在目标端核对；文件内容不会自动复制。</p>
    </Overlay>;
  }
  if (dialog.kind === 'execute') return <Overlay title="继续任务" onClose={onClose} onSubmit={submit} busy={busy || picking || !project} error={error} submitLabel="立即执行"><p>在所选设备新建会话，携带任务上下文和来源信息。</p><label>接续来源<select name="sourceSessionId" defaultValue={task.sessionIds.at(-1) || ''}><option value="">仅任务上下文</option>{task.sessionIds.map(id => { const session = data.sessions.find(item => item.id === id); return session && <option key={id} value={id}>{session.title} · {data.devices.find(item => item.id === session.deviceId)?.name || '未知设备'} / {session.agentLabel || session.agent}</option>; })}</select></label><label>补充指令<textarea name="instruction" rows={3} maxLength={12000} placeholder="本轮希望完成什么？" /></label>
    {targetsError ? <p role="alert">{errorMessage(targetsError)}</p> : !targets ? <p role="status">正在读取执行目标…</p> : !project ? <p role="alert">{targets.localError || '未发现可用的 Agent 执行目标'}</p> : <><label>执行目标<select value={projectIndex} onChange={event => { setProjectIndex(Number(event.target.value)); setCwd(''); setModel(''); setEffort(''); }}>{targets.projects.map((item, index) => <option key={`${item.deviceId}:${item.id}`} value={index}>{item.deviceName} / {item.name} · {String(item.protocol || 'legacy').toUpperCase()} · {item.online ? '在线' : '离线，等待连接'}</option>)}</select></label><label>IDE 工作目录<div className="tc-picker-row"><input value={cwd} onChange={event => setCwd(event.target.value)} maxLength={2000} placeholder="未选择，使用目标默认目录" /><button type="button" className="button secondary" disabled={picking} onClick={() => void chooseDirectory()}>选择目录</button><button type="button" className="button ghost" onClick={() => setCwd('')}>使用默认</button></div></label>{!!project.commonDirectories?.length && <div className="tc-actions">{project.commonDirectories.map(path => <button className="button secondary" type="button" key={path} onClick={() => setCwd(path)}>{path}</button>)}</div>}<div className="tc-two"><label>模型<select value={model} onChange={event => { setModel(event.target.value); setEffort(''); }}><option value="">使用 Agent 默认模型{project.defaultModel ? `（${project.defaultModel}）` : ''}</option>{project.models?.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select></label><label>思考强度<select value={effort} onChange={event => setEffort(event.target.value)}><option value="">使用模型默认</option>{efforts.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select></label></div><p className="tc-meta">{selectedModel?.description || '不选择时沿用目标 Agent 的默认配置。'}</p></>}
    <h3>{task.title}</h3><p>{taskContent(task)}</p><p className="tc-meta">目录选择器会在目标机器打开；模型和思考强度以目标 Agent 实际支持范围为准。</p></Overlay>;
  if (dialog.kind === 'respond') {
    const request = execution?.request, params = request?.params || {};
    const questions = request?.method === 'item/tool/requestUserInput' ? params.questions : undefined;
    return <Overlay title="回复 Agent" onClose={onClose} onSubmit={submit} busy={busy} error={error} submitLabel="发送回复">{questions ? questions.map(question => <label key={question.id}>{question.question}{question.options?.length && <p className="tc-meta">{question.options.map(option => `${option.label}：${option.description || ''}`).join('；')}</p>}<textarea name={`answer-${question.id}`} required maxLength={12000} /></label>) : <><p>{String(params.reason || (params.toolCall && typeof params.toolCall === 'object' && 'title' in params.toolCall ? params.toolCall.title : '') || 'Agent 请求执行以下操作')}</p><pre>{String(params.command || JSON.stringify(params.toolCall || params, null, 2))}</pre><label>本次操作<select name="decision" defaultValue="decline"><option value="decline">拒绝</option><option value="accept">允许本次操作</option></select></label></>}</Overlay>;
  }
  if (dialog.kind === 'failed') return <Overlay title="报告交接失败" onClose={onClose} onSubmit={submit} busy={busy} error={error} submitLabel="记录失败"><label>失败原因<textarea name="note" required maxLength={2000} /></label></Overlay>;
  if (dialog.kind === 'started') {
    const candidates = data.sessions.filter(session => session.deviceId === handoff?.deviceId && session.agent === handoff.agent && !data.tasks.some(item => item.sessionIds.includes(session.id)));
    return <Overlay title="关联已开始的新会话" onClose={onClose} onSubmit={submit} busy={busy} error={error} submitLabel="确认已开始"><p>请先在目标 Agent 开始工作并同步会话，再选择实际的接续会话。</p><label>目标会话<select name="sessionId" required defaultValue=""><option value="">{candidates.length ? '请选择实际接续会话' : '暂无新会话，请同步后重试'}</option>{candidates.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label></Overlay>;
  }
  const content = handoff ? packetText(handoff, data) : '';
  return <Overlay title="交接上下文" onClose={onClose} busy={false} error={copyState}><p className="tc-meta">{handoff && handoffLabels[handoff.status]} · 上下文 v{handoff?.packet.contextVersion}</p><textarea readOnly rows={16} aria-label="交接包内容" value={content} /><div className="tc-actions"><button className="button secondary" type="button" onClick={() => { void navigator.clipboard.writeText(content).then(() => setCopyState('已复制'), () => setCopyState('无法自动复制，请手动选择文本。')); }}>复制</button><button className="button secondary" type="button" onClick={() => { const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `handoff-${handoff?.id}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>下载文本</button></div></Overlay>;
}
