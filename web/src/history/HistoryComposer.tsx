import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { apiRequest } from '../api/client.js';
import { pendingHistoryMessages } from './historyTimeline.js';
import { renderMessages } from '../components/historyView.js';
import { historyRunConfig, runDirectoryName } from '../tasks/agentRunConfig.js';
import type { AgentProject, HistoryMessage, InteractionRequest, Session } from '../../../shared/taskTypes.js';
import { ModelEffortMenu } from '../tasks/ModelEffortMenu.js';
import overlayStyles from '../styles/Overlay.module.css';

interface ComposerJob { id: string; status: string; prompt: string; message?: string; output?: string; turnId?: string | null; conversationId?: string; createdAt?: string; releaseStatus?: string; executionTransport?: string; request?: InteractionRequest | null }
interface StatusResponse { execution?: ComposerJob | null; executions?: ComposerJob[] }
interface Targets { projects: AgentProject[]; localError?: string }
interface BranchState { repository: boolean; current?: string; changes: number; branches: string[] }
interface DirectoryResult { status: 'pending' | 'selecting' | 'completed' | 'cancelled' | 'failed'; requestId: string; cwd?: string; message?: string }
interface Draft { text: string; requestId: string; sentText: string }
const drafts = new Map<string, Draft>();
const newRequests = new Map<string, { signature: string; requestId: string }>();
const busy = new Set(['queued', 'launching', 'running', 'waiting', 'unknown']);
const names: Record<string, string> = { blocked: '会话被占用 · 未发送', queued: '等待执行', launching: '正在连接 Agent', running: '正在回复', waiting: '等待你处理', completed: '本轮完成', failed: '执行失败', interrupted: '已停止', unknown: '结果待核对' };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
function requestId() { return crypto.randomUUID(); }
function LiveMessages({ messages }: { messages: HistoryMessage[] }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    const scroll = node.closest<HTMLElement>('.history-chat-scroll');
    const follow = scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
    node.innerHTML = messages.length ? renderMessages(messages) : '';
    if (follow && scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [messages]);
  return <div className="history-messages" role="log" aria-live="polite" ref={host} />;
}

export function HistoryComposer({ session, historyMessages, canEdit, syncHistory }: { session: Session; historyMessages: HistoryMessage[]; canEdit: boolean; syncHistory(id: string): Promise<HistoryMessage[] | null> }) {
  const [outputHost, setOutputHost] = useState<HTMLElement | null>(null);
  const [text, setText] = useState(() => drafts.get(session.id)?.text || '');
  const [error, setError] = useState('');
  const [newStatus, setNewStatus] = useState('');
  const [projectIndex, setProjectIndex] = useState<number | null>(null);
  const [cwd, setCwd] = useState('');
  const [branchCwd, setBranchCwd] = useState('');
  const [directoryRequestId, setDirectoryRequestId] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [branchActionError, setBranchActionError] = useState('');
  const [branchSearch, setBranchSearch] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [branchMutating, setBranchMutating] = useState(false);
  const [picking, setPicking] = useState(false);
  const [responding, setResponding] = useState(false);
  const [decision, setDecision] = useState('decline');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [syncedMessages, setSyncedMessages] = useState<HistoryMessage[] | null>(null);
  const [optimistic, setOptimistic] = useState<ComposerJob | null>(null);
  const restored = useRef(new Set<string>());
  const syncKey = useRef('');
  const syncing = useRef(false);
  const queryClient = useQueryClient();
  const canSendNative = Boolean(session.managed || (session.agent === 'codex' && (!session.deviceId || session.deviceId === 'local') && session.sessionId && !session.archived));
  useLayoutEffect(() => { setOutputHost(document.getElementById('historyLiveOutput')); }, [session.id]);
  const targets = useQuery({ queryKey: ['history', 'targets'], queryFn: ({ signal }) => apiRequest<Targets>('/api/task-center/codex', { signal }), enabled: canEdit, retry: false });
  const status = useQuery({ queryKey: ['history', 'continue', session.id], queryFn: ({ signal }) => apiRequest<StatusResponse>(`/api/agent-sessions/${encodeURIComponent(session.id)}/continue`, { signal }), enabled: canEdit && canSendNative, refetchInterval: canEdit && canSendNative ? 2500 : false, refetchIntervalInBackground: false, retry: false });
  const persistedExecutions = status.data?.executions || (status.data?.execution ? [status.data.execution] : []);
  const awaitingPersistence = optimistic && !persistedExecutions.some(item => item.id === optimistic.id);
  const executions = awaitingPersistence ? [...persistedExecutions, optimistic] : persistedExecutions;
  const job = awaitingPersistence ? optimistic : status.data?.execution || persistedExecutions.at(-1) || null;
  const projects = targets.data?.projects || [];
  const index = projectIndex ?? historyRunConfig(projects, session).projectIndex;
  const project = projects[index];
  useEffect(() => {
    if (!targets.data || projectIndex !== null) return;
    const config = historyRunConfig(targets.data.projects, session);
    setProjectIndex(config.projectIndex);
    setCwd(config.cwd);
  }, [targets.data, projectIndex, session]);
  const branchDirectoryPending = cwd.trim() !== branchCwd;
  const branchKey = ['task-center', 'git', project?.deviceId || '', project?.id || '', project?.cwd || '', branchCwd] as const;
  const branchQuery = useQuery({
    queryKey: branchKey,
    queryFn: ({ signal }) => apiRequest<BranchState>('/api/task-center/git', { method: 'POST', body: JSON.stringify({ action: 'list', projectId: project?.id, deviceId: project?.deviceId, cwd: branchCwd }), signal }),
    enabled: canEdit && project?.deviceId === 'local' && !branchDirectoryPending,
    retry: false
  });
  const branch = branchDirectoryPending ? undefined : branchQuery.data;
  const branchBusy = branchDirectoryPending || branchQuery.isFetching || branchMutating;
  const branchError = branchDirectoryPending ? '' : branchActionError || (branchQuery.error ? errorMessage(branchQuery.error) : '');
  const disabled = branchMutating || picking;
  const pending = pendingHistoryMessages(syncedMessages || historyMessages, executions);
  const send = useMutation({ retry: false, mutationFn: ({ message, id }: { message: string; id: string }) => apiRequest<{ executionId: string }>(`/api/agent-sessions/${encodeURIComponent(session.id)}/continue`, { method: 'POST', body: JSON.stringify({ message, requestId: id }) }), onSuccess: (result, variables) => {
    const draft = drafts.get(session.id)!;
    if (draft.text.trim() === variables.message) { draft.text = ''; setText(''); }
    draft.requestId = '';
    setOptimistic({ id: result.executionId, turnId: session.managed ? result.executionId : undefined, createdAt: new Date().toISOString(), status: 'queued', prompt: variables.message, message: session.managed ? '已提交到当前会话' : '已提交到原会话' });
    setError(''); void status.refetch();
  }, onError: failure => setError(`${errorMessage(failure)}。输入已保留；再次发送相同内容不会重复提交。`) });
  const create = useMutation({ retry: false, mutationFn: ({ message, id }: { message: string; id: string }) => {
    if (!project) throw new Error('没有可用 Agent');
    return apiRequest<{ sessionId: string }>(`/api/sessions/${encodeURIComponent(session.id)}/continue-as-new`, { method: 'POST', body: JSON.stringify({ targetAgent: project.agent || 'codex', deviceId: project.deviceId, projectId: project.id, cwd: cwd.trim(), directoryRequestId: directoryRequestId || undefined, model, reasoningEffort: effort, message, requestId: id }) });
  }, onSuccess: result => { drafts.delete(session.id); newRequests.delete(session.id); location.hash = `history/${result.sessionId}`; }, onError: failure => setNewStatus(`${errorMessage(failure)}。再次点击可重试，输入已保留。`) });
  const control = useMutation({ retry: false, mutationFn: (body: Record<string, unknown>) => apiRequest('/api/task-center/execution-action', { method: 'POST', body: JSON.stringify(body) }), onSuccess: () => { setResponding(false); setError(''); void status.refetch(); }, onError: failure => setError(errorMessage(failure)) });
  useEffect(() => { if (!drafts.has(session.id)) drafts.set(session.id, { text: '', requestId: '', sentText: '' }); }, [session.id]);
  useEffect(() => {
    if (!status.data || syncing.current) return;
    const signature = JSON.stringify(status.data.executions || status.data.execution || null);
    if (signature === syncKey.current) return;
    syncKey.current = signature; syncing.current = true;
    void syncHistory(session.id).then(messages => { if (messages) setSyncedMessages(messages); }).catch(failure => setError(errorMessage(failure))).finally(() => { syncing.current = false; });
  }, [status.data, session.id, syncHistory]);
  useEffect(() => {
    if (job?.status !== 'blocked' || restored.current.has(job.id)) return;
    const draft = drafts.get(session.id);
    if (draft && !draft.text.trim()) { draft.text = job.prompt; draft.requestId = ''; setText(job.prompt); }
    restored.current.add(job.id);
  }, [job?.id, job?.status, session.id]);
  useEffect(() => { const timer = setTimeout(() => setBranchCwd(cwd.trim()), 300); return () => clearTimeout(timer); }, [cwd]);
  useEffect(() => { setBranchActionError(''); setBranchSearch(''); }, [project?.id, project?.deviceId, cwd]);
  function updateText(value: string) {
    setText(value);
    const draft = drafts.get(session.id) || { text: '', requestId: '', sentText: '' };
    draft.text = value;
    if (value.trim() !== draft.sentText) draft.requestId = '';
    drafts.set(session.id, draft);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSendNative || !canEdit || send.isPending || disabled || (job && busy.has(job.status)) || job?.releaseStatus === 'releasing' || !text.trim()) return;
    const draft = drafts.get(session.id)!;
    draft.requestId ||= requestId(); draft.sentText = text.trim();
    setError(''); send.mutate({ message: text.trim(), id: draft.requestId });
  }
  function createSession() {
    if (!project || create.isPending || send.isPending || disabled) return;
    if (project.deviceId !== (session.deviceId || 'local') && !cwd.trim()) { setNewStatus('跨设备交接请先在目标设备明确选择工作目录。'); return; }
    const message = text.trim();
    const signature = JSON.stringify([project.deviceId, project.id, cwd, directoryRequestId, model, effort, message]);
    let attempt = newRequests.get(session.id);
    if (!attempt || attempt.signature !== signature) { attempt = { signature, requestId: requestId() }; newRequests.set(session.id, attempt); }
    setNewStatus('正在带上上下文…'); create.mutate({ message, id: attempt.requestId });
  }
  async function chooseDirectory() {
    if (!project || picking) return;
    setPicking(true); setNewStatus('');
    try {
      const response = await apiRequest<DirectoryResult>('/api/task-center/directory-picker', { method: 'POST', body: JSON.stringify({ deviceId: project.deviceId, projectId: project.id }) });
      if (response.status === 'completed') { setCwd(response.cwd || ''); setDirectoryRequestId(response.requestId || ''); return; }
      for (let attempt = 0; attempt < 300; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const result = await apiRequest<DirectoryResult>(`/api/task-center/directory-picker?requestId=${encodeURIComponent(response.requestId)}`);
        if (result.status === 'completed') { setCwd(result.cwd || ''); setDirectoryRequestId(response.requestId); return; }
        if (result.status === 'cancelled') throw new Error('已取消选择目录');
        if (result.status === 'failed') throw new Error(result.message || '无法选择目录');
      }
      throw new Error('等待目录选择超时');
    } catch (failure) { setNewStatus(errorMessage(failure)); }
    finally { setPicking(false); }
  }
  async function branchAction(action: 'switch' | 'create', name: string) {
    if (!project || branchMutating || branchDirectoryPending) return;
    setBranchMutating(true); setBranchActionError('');
    try {
      await queryClient.cancelQueries({ queryKey: branchKey });
      const result = await apiRequest<BranchState>('/api/task-center/git', { method: 'POST', body: JSON.stringify({ action, branch: name, projectId: project.id, deviceId: project.deviceId, cwd }) });
      queryClient.setQueryData(branchKey, result);
      if (action === 'create') setNewBranch('');
    } catch (failure) { setBranchActionError(errorMessage(failure)); }
    finally { setBranchMutating(false); }
  }
  const canSend = canEdit && canSendNative && !send.isPending && !create.isPending && !disabled && !(job && busy.has(job.status)) && job?.releaseStatus !== 'releasing' && !!text.trim();
  const statusText = send.isPending ? '正在发送…' : job ? `${names[job.status] || job.status} · ${job.message || ''}${job.executionTransport === 'desktop-ipc' ? ' · 由客户端执行；审批和问题请在客户端处理' : ''}${job.releaseStatus === 'releasing' ? ' · 正在释放网页连接' : job.releaseStatus === 'released' ? ' · 网页连接已释放' : job.releaseStatus === 'failed' ? ' · 会话释放失败，请检查服务进程' : ''}` : session.managed ? '已继承原会话上下文，直接输入下一条消息即可。' : canSendNative ? '消息将追加到原会话，沿用其上下文与配置。' : '选择其他 Agent 新开会话，即可带上上下文继续。';
  return <>{outputHost && createPortal(<LiveMessages messages={pending} />, outputHost)}<section className="history-composer" id="historyComposer" aria-label="会话输入框">
    {!canEdit ? <p className="history-meta">只读成员无法发送消息。</p> : <><div className="conversation-switch tc-create-shell"><div className="tc-create-context" aria-label="新会话运行环境">
      {targets.isPending ? <p className="tc-create-hint" role="status">正在读取运行配置…</p> : targets.isError ? <p role="alert">{errorMessage(targets.error)}</p> : project ? <>
        <details className="tc-config-menu tc-directory-menu" name="create-config"><summary aria-label={`工作目录：${cwd || project.cwd || '默认目录'}`}>▱ <span>{runDirectoryName(cwd || project.cwd || '')}</span><span aria-hidden="true">⌄</span></summary><div className="tc-config-panel"><label className="tc-create-setting">工作目录<input value={cwd} onChange={event => { setCwd(event.target.value); setDirectoryRequestId(''); }} placeholder={project.cwd || '输入工作目录'} maxLength={2000} disabled={disabled} /></label><div className="tc-actions"><button type="button" className="button secondary" disabled={disabled} onClick={() => void chooseDirectory()}>选择目录</button><button type="button" className="button ghost" disabled={disabled} onClick={() => { setCwd(''); setDirectoryRequestId(''); }}>使用默认目录</button></div>{!!project.commonDirectories?.length && <div className="tc-directory-options">{project.commonDirectories.slice(0, 4).map(path => <button key={path} type="button" onClick={() => { setCwd(path); setDirectoryRequestId(''); }}>{runDirectoryName(path)}<small>{path}</small></button>)}</div>}</div></details>
        <label className="tc-target-control">▣ <select aria-label="执行位置" value={index} onChange={event => { setProjectIndex(Number(event.target.value)); setCwd(''); setDirectoryRequestId(''); setModel(''); setEffort(''); }}>{projects.map((item, at) => <option key={`${item.deviceId}:${item.id}`} value={at}>{item.name} · {item.deviceName}{item.online ? '' : '（离线）'}</option>)}</select></label>
        {project.deviceId === 'local' && <details className="tc-config-menu tc-branch-menu" name="create-config" onToggle={event => { if (event.currentTarget.open && !branchBusy) void branchQuery.refetch(); }}><summary aria-label="Git 分支">⑂ <span>{branch?.repository ? branch.current || '分离 HEAD' : branchBusy ? '读取分支…' : branchError ? '分支读取失败' : branch ? '非 Git 目录' : 'Git 分支'}</span><span aria-hidden="true">⌄</span></summary><div className="tc-config-panel">{branchBusy ? <p role="status">正在处理分支…</p> : branchError ? <p role="alert">{branchError}</p> : branch?.repository ? <><input aria-label="搜索分支" value={branchSearch} onChange={event => setBranchSearch(event.target.value)} placeholder="搜索分支" /><p className="tc-create-hint">当前：{branch.current || '分离 HEAD'} · 未提交：{branch.changes} 项</p><div className="tc-branch-options">{branch.branches.filter(name => name.toLowerCase().includes(branchSearch.toLowerCase())).map(name => <button key={name} type="button" disabled={disabled} aria-pressed={name === branch.current} onClick={() => void branchAction('switch', name)}>{name}{name === branch.current ? ' ✓' : ''}</button>)}</div><label className="tc-create-setting">新分支<input aria-label="新分支名称" value={newBranch} onChange={event => setNewBranch(event.target.value)} maxLength={200} /></label><button type="button" className="button secondary" disabled={disabled || !newBranch.trim()} onClick={() => void branchAction('create', newBranch.trim())}>创建并切换</button></> : <p className="tc-create-hint">当前目录不是 Git 仓库。</p>}</div></details>}
      </> : <p role="alert" className="tc-create-hint">{targets.data?.localError || '没有可用 Agent'}</p>}</div>
      <form className="conversation-composer" onSubmit={submit}><label className="history-sr-only" htmlFor="historyReply">发送消息</label><textarea id="historyReply" rows={3} maxLength={12000} placeholder="继续讨论，或描述下一步需要完成的工作…" value={text} onChange={event => updateText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} disabled={send.isPending || create.isPending || disabled} required />
        <div className="history-compose-footer"><div className="tc-create-tools">{session.agent === 'codex' && session.sessionId ? <a className="conversation-context" href={`codex://threads/${encodeURIComponent(session.sessionId)}`}>在 Codex 中打开 ↗</a> : <span className="conversation-context">{session.agentLabel || session.agent} · {session.model || '默认配置'}</span>}<span className="history-meta">⌘ / Ctrl + Enter</span></div><div className="tc-create-send"><div className="conversation-new-controls">
          {project && <ModelEffortMenu project={project} model={model} effort={effort} disabled={create.isPending || send.isPending || disabled} onModelChange={setModel} onEffortChange={setEffort} />}
          <button type="button" className="button secondary conversation-new-button" disabled={!project || create.isPending || send.isPending || disabled} onClick={createSession}>带上下文新开会话 →</button></div><button type="submit" aria-label="发送消息" title="发送消息" disabled={!canSend}>↑</button></div></div><p className="conversation-new-status" role="status">{newStatus}</p>
      </form></div><p className="history-meta" role="status">{statusText}</p>{status.isError && <p role="alert">{errorMessage(status.error)}</p>}{error && <p role="alert">{error}</p>}
      <div className="history-compose-actions">{job && <>{['queued', 'running', 'waiting'].includes(job.status) && <button type="button" disabled={control.isPending} onClick={() => control.mutate({ executionId: job.id, action: 'stop' })}>停止</button>}{job.status === 'waiting' && job.request && <button type="button" onClick={() => setResponding(true)}>处理请求</button>}{job.status === 'unknown' && <button type="button" disabled={control.isPending} onClick={() => control.mutate({ executionId: job.id, action: 'reconcile' })}>核对结果</button>}{!busy.has(job.status) && <button type="button" onClick={() => { void syncHistory(session.id).then(messages => setSyncedMessages(messages)); void queryClient.invalidateQueries({ queryKey: ['history', 'detail', session.id] }); }}>刷新原始记录</button>}{['failed', 'interrupted', 'blocked'].includes(job.status) && <><button type="button" onClick={() => updateText(job.prompt)}>重新编辑本轮消息</button><button type="button" onClick={() => void navigator.clipboard.writeText(job.prompt).catch(() => setError('无法自动复制，请使用输入框中的文本。'))}>复制本轮消息</button></>}</>}</div>
    </>}
    {responding && job?.request && <div className={overlayStyles.backdrop}><div className={`tc-dialog ${overlayStyles.panel}`} role="dialog" aria-modal="true" aria-label="回复 Agent 请求"><form onSubmit={event => { event.preventDefault(); const questions = job.request?.method === 'item/tool/requestUserInput' ? job.request.params?.questions : undefined; control.mutate({ executionId: job.id, action: 'respond', ...(questions ? { answers: Object.fromEntries(questions.map(question => [question.id, answers[question.id] || ''])) } : { decision }) }); }}><h2>回复 Agent 请求</h2>{job.request.method === 'item/tool/requestUserInput' ? job.request.params?.questions?.map(question => <label key={question.id}>{question.question}{question.options?.length && <p>{question.options.map(option => `${option.label}：${option.description || ''}`).join('；')}</p>}<textarea required maxLength={12000} value={answers[question.id] || ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} /></label>) : <><pre>{String(job.request.params?.command || JSON.stringify(job.request.params, null, 2))}</pre><label>本次操作<select value={decision} onChange={event => setDecision(event.target.value)}><option value="decline">拒绝</option><option value="accept">允许本次操作</option></select></label></>}{error && <p role="alert">{error}</p>}<button type="button" disabled={control.isPending} onClick={() => setResponding(false)}>取消</button><button type="submit" disabled={control.isPending}>发送回复</button></form></div></div>}
  </section></>;
}
