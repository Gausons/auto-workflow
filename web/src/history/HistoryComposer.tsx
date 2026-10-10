import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { apiRequest } from '../api/client.js';
import { pendingHistoryMessages } from './historyTimeline.js';
import { canContinueHistory } from './historyCapabilities.js';
import { renderMessages } from '../components/historyView.js';
import { DismissibleDetails } from '../components/DismissibleDetails.js';
import { historyRunConfig, runDirectoryName, runEffortLabel } from '../tasks/agentRunConfig.js';
import type { AgentProject, HistoryMessage, InteractionRequest, Session } from '../../../shared/taskTypes.js';
import { ModelEffortMenu } from '../tasks/ModelEffortMenu.js';
import { requestGitBranches } from '../tasks/gitBranches.js';
import { waitForRemoteRequest } from '../tasks/remoteRequest.js';
import overlayStyles from '../styles/Overlay.module.css';
import styles from './HistoryComposer.module.css';

interface ComposerJob { id: string; status: string; prompt: string; message?: string; output?: string; turnId?: string | null; conversationId?: string; createdAt?: string; releaseStatus?: string; executionTransport?: string; request?: InteractionRequest | null; control?: { id: string } | null; controlError?: string | null }
interface StatusResponse { execution?: ComposerJob | null; executions?: ComposerJob[] }
interface Targets { projects: AgentProject[]; localError?: string }
interface DirectoryResult { status: 'pending' | 'selecting' | 'completed' | 'cancelled' | 'failed'; requestId: string; cwd?: string; message?: string }
interface Draft { text: string; requestId: string; sentText: string }
interface NewSessionDraft { mode: boolean; target: string | null; cwd: string; directoryRequestId: string; model: string; effort: string }
interface CreateInput { targetAgent: string; deviceId?: string; projectId: string; cwd: string; directoryRequestId?: string; model: string; reasoningEffort: string; message: string; requestId: string }
const drafts = new Map<string, Draft>();
const newSessionDrafts = new Map<string, NewSessionDraft>();
const newRequests = new Map<string, { signature: string; requestId: string; pending?: boolean }>();
const projectIdentity = (project: AgentProject) => JSON.stringify([project.deviceId, project.id]);
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
  const [newSessionMode, setNewSessionMode] = useState(() => newSessionDrafts.get(session.id)?.mode || false);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(() => newSessionDrafts.get(session.id)?.target ?? null);
  const [cwd, setCwd] = useState(() => newSessionDrafts.get(session.id)?.cwd || '');
  const [branchCwd, setBranchCwd] = useState('');
  const [directoryRequestId, setDirectoryRequestId] = useState(() => newSessionDrafts.get(session.id)?.directoryRequestId || '');
  const [model, setModel] = useState(() => newSessionDrafts.get(session.id)?.model || '');
  const [effort, setEffort] = useState(() => newSessionDrafts.get(session.id)?.effort || '');
  const [branchActionError, setBranchActionError] = useState('');
  const [branchSearch, setBranchSearch] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [branchMutating, setBranchMutating] = useState(false);
  const [picking, setPicking] = useState(false);
  const pickerPending = useRef(false);
  const mounted = useRef(true);
  const actions = useRef(new AbortController());
  const [responding, setResponding] = useState(false);
  const [decision, setDecision] = useState('decline');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [optimistic, setOptimistic] = useState<ComposerJob | null>(null);
  const restored = useRef(new Set<string>());
  const syncKey = useRef('');
  const syncing = useRef(false);
  const queryClient = useQueryClient();
  const canSendNative = canContinueHistory(session);
  useLayoutEffect(() => { mounted.current = true; actions.current = new AbortController(); return () => { mounted.current = false; actions.current.abort(); }; }, []);
  useLayoutEffect(() => { newSessionDrafts.set(session.id, { mode: newSessionMode, target: selectedTarget, cwd, directoryRequestId, model, effort }); }, [session.id, newSessionMode, selectedTarget, cwd, directoryRequestId, model, effort]);
  useLayoutEffect(() => { setOutputHost(document.getElementById('historyLiveOutput')); }, [session.id]);
  const targets = useQuery({ queryKey: ['history', 'targets'], queryFn: ({ signal }) => apiRequest<Targets>('/api/task-center/codex', { signal }), enabled: canEdit && newSessionMode, retry: false });
  const status = useQuery({ queryKey: ['history', 'continue', session.id], queryFn: ({ signal }) => apiRequest<StatusResponse>(`/api/agent-sessions/${encodeURIComponent(session.id)}/continue`, { signal }), enabled: canEdit && canSendNative, retry: false });
  const persistedExecutions = status.data?.executions || (status.data?.execution ? [status.data.execution] : []);
  const awaitingPersistence = optimistic && !persistedExecutions.some(item => item.id === optimistic.id);
  const executions = awaitingPersistence ? [...persistedExecutions, optimistic] : persistedExecutions;
  const job = awaitingPersistence ? optimistic : status.data?.execution || persistedExecutions.at(-1) || null;
  const projects = targets.data?.projects || [];
  const index = selectedTarget === null ? historyRunConfig(projects, session).projectIndex : projects.findIndex(item => projectIdentity(item) === selectedTarget);
  const project = projects[index];
  useEffect(() => {
    if (!targets.data || selectedTarget !== null) return;
    const config = historyRunConfig(targets.data.projects, session);
    const target = targets.data.projects[config.projectIndex];
    if (!target) return;
    setSelectedTarget(projectIdentity(target));
    setCwd(config.cwd);
  }, [targets.data, selectedTarget, session]);
  const branchDirectoryPending = cwd.trim() !== branchCwd;
  const branchKey = ['task-center', 'git', project?.deviceId || '', project?.id || '', project?.cwd || '', branchCwd] as const;
  const branchQuery = useQuery({
    queryKey: branchKey,
    queryFn: ({ signal }) => requestGitBranches(queryClient, project!, branchCwd, 'list', undefined, signal),
    enabled: canEdit && newSessionMode && Boolean(project) && !branchDirectoryPending,
    retry: false
  });
  const branch = branchDirectoryPending ? undefined : branchQuery.data;
  const branchBusy = branchDirectoryPending || branchQuery.isFetching || branchMutating;
  const branchError = branchDirectoryPending ? '' : branchActionError || (branchQuery.error ? errorMessage(branchQuery.error) : '');
  const disabled = branchMutating || picking;
  const pending = pendingHistoryMessages(historyMessages, executions);
  const send = useMutation({ retry: false, mutationFn: ({ message, id }: { message: string; id: string }) => apiRequest<{ executionId: string }>(`/api/agent-sessions/${encodeURIComponent(session.id)}/continue`, { method: 'POST', body: JSON.stringify({ message, requestId: id }) }), onSuccess: (result, variables) => {
    const draft = drafts.get(session.id)!;
    if (draft.text.trim() === variables.message) { draft.text = ''; setText(''); }
    draft.requestId = '';
    setOptimistic({ id: result.executionId, turnId: session.managed ? result.executionId : undefined, createdAt: new Date().toISOString(), status: 'queued', prompt: variables.message, message: session.managed ? '已提交到当前会话' : '已提交到原会话' });
    setError(''); void status.refetch();
  }, onError: failure => setError(`${errorMessage(failure)}。输入已保留；再次发送相同内容不会重复提交。`) });
  const createKey = ['history', 'create', session.id];
  const creations = useMutationState({ filters: { mutationKey: createKey, exact: true }, select: mutation => ({
    status: mutation.state.status, error: mutation.state.error,
    data: mutation.state.data as { sessionId: string } | undefined,
    variables: mutation.state.variables as CreateInput | undefined
  }) });
  const latestCreation = creations.at(-1);
  const creating = latestCreation?.status === 'pending';
  const create = useMutation({ mutationKey: createKey, retry: false,
    mutationFn: (input: CreateInput) => apiRequest<{ sessionId: string }>(`/api/sessions/${encodeURIComponent(session.id)}/continue-as-new`, { method: 'POST', body: JSON.stringify(input) }),
    onSettled: () => { const attempt = newRequests.get(session.id); if (attempt) attempt.pending = false; }
  });
  useEffect(() => {
    if (latestCreation?.status !== 'success' || !latestCreation.data || newRequests.get(session.id)?.requestId !== latestCreation.variables?.requestId) return;
    drafts.delete(session.id); newSessionDrafts.delete(session.id); newRequests.delete(session.id);
    location.hash = `history/${latestCreation.data.sessionId}`;
  }, [session.id, latestCreation?.status, latestCreation?.data?.sessionId, latestCreation?.variables?.requestId]);
  const control = useMutation({ retry: false, mutationFn: (body: Record<string, unknown>) => apiRequest('/api/task-center/execution-action', { method: 'POST', body: JSON.stringify(body) }), onSuccess: () => { setResponding(false); setError(''); void status.refetch(); }, onError: failure => setError(errorMessage(failure)) });
  useEffect(() => { if (!drafts.has(session.id)) drafts.set(session.id, { text: '', requestId: '', sentText: '' }); }, [session.id]);
  useEffect(() => {
    if (!status.data || syncing.current) return;
    const signature = JSON.stringify(status.data.executions || status.data.execution || null);
    if (signature === syncKey.current) return;
    syncKey.current = signature; syncing.current = true;
    void syncHistory(session.id).catch(failure => setError(errorMessage(failure))).finally(() => { syncing.current = false; });
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
    if (newSessionMode) { void createSession(); return; }
    if (!canSend) return;
    const draft = drafts.get(session.id)!;
    draft.requestId ||= requestId(); draft.sentText = text.trim();
    setError(''); send.mutate({ message: text.trim(), id: draft.requestId });
  }
  async function createSession() {
    if (!canCreate || !project || pickerPending.current || newRequests.get(session.id)?.pending) return;
    if (project.deviceId !== (session.deviceId || 'local') && !cwd.trim()) { setNewStatus('跨设备交接请先在目标设备明确选择工作目录。'); return; }
    let directory = { cwd: cwd.trim() || project.cwd, directoryRequestId };
    if (project.deviceId !== 'local' && directory.cwd !== project.cwd && !directory.directoryRequestId) {
      const selected = await chooseDirectory();
      if (!selected || !mounted.current) return;
      directory = selected;
    }
    const message = text.trim();
    const signature = JSON.stringify([project.deviceId, project.id, directory.cwd, directory.directoryRequestId, model, effort, message]);
    let attempt = newRequests.get(session.id);
    if (!attempt || attempt.signature !== signature) { attempt = { signature, requestId: requestId() }; newRequests.set(session.id, attempt); }
    attempt.pending = true; setNewStatus('');
    create.mutate({ targetAgent: project.agent || 'codex', deviceId: project.deviceId, projectId: project.id, cwd: directory.cwd, directoryRequestId: directory.directoryRequestId || undefined, model, reasoningEffort: effort, message, requestId: attempt.requestId });
  }
  async function chooseDirectory() {
    if (!canEdit || !newSessionMode || !project || configurationDisabled || pickerPending.current) return null;
    pickerPending.current = true;
    setPicking(true); setNewStatus('请在目标设备选择并确认工作目录，确认后将继续当前操作。');
    try {
      const signal = actions.current.signal;
      const response = await apiRequest<DirectoryResult>('/api/task-center/directory-picker', { method: 'POST', body: JSON.stringify({ deviceId: project.deviceId, projectId: project.id }), signal });
      const result = await waitForRemoteRequest(queryClient, 'directoryRequests', response.requestId, response,
        () => apiRequest<DirectoryResult>(`/api/task-center/directory-picker?requestId=${encodeURIComponent(response.requestId)}`, { signal }), 300_000, signal);
      if (!mounted.current) return null;
      if (result.status === 'cancelled') throw new Error('已取消选择目录');
      if (result.status !== 'completed') throw new Error(result.message || '无法选择目录');
      if (!result.cwd || (project.deviceId !== 'local' && !response.requestId)) throw new Error('目录选择结果不完整，请重新选择');
      const selected = { cwd: result.cwd, directoryRequestId: response.requestId || '' };
      setCwd(selected.cwd); setDirectoryRequestId(selected.directoryRequestId); setNewStatus('');
      return selected;
    } catch (failure) { if (mounted.current) setNewStatus(errorMessage(failure)); return null; }
    finally { pickerPending.current = false; if (mounted.current) setPicking(false); }
  }
  async function branchAction(action: 'switch' | 'create', name: string) {
    if (!canEdit || !newSessionMode || !project || configurationDisabled || branchDirectoryPending) return;
    setBranchMutating(true); setBranchActionError('');
    try {
      await queryClient.cancelQueries({ queryKey: branchKey });
      const result = await requestGitBranches(queryClient, project, cwd, action, name, actions.current.signal);
      queryClient.setQueryData(branchKey, result);
      if (action === 'create') setNewBranch('');
    } catch (failure) { setBranchActionError(errorMessage(failure)); }
    finally { setBranchMutating(false); }
  }
  const executionLocked = Boolean(job && busy.has(job.status)) || job?.releaseStatus === 'releasing';
  const configurationDisabled = disabled || send.isPending || creating || executionLocked;
  const canSend = canEdit && canSendNative && !configurationDisabled && !!text.trim();
  const canCreate = canEdit && newSessionMode && Boolean(project) && !configurationDisabled;
  const currentDevice = projects.find(item => item.deviceId === session.deviceId)?.deviceName || (session.deviceId && session.deviceId !== 'local' ? session.deviceId : '工作台所在设备');
  const currentModel = [session.model || '沿用会话模型', runEffortLabel(session.reasoningEffort || '')].filter(Boolean).join(' · ');
  const statusText = send.isPending ? '正在发送…' : job ? `${names[job.status] || job.status} · ${job.message || ''}${job.control ? ' · 等待目标设备处理操作' : ''}${job.controlError ? ` · ${job.controlError}` : ''}${job.executionTransport === 'desktop-ipc' ? ' · 由客户端执行；审批和问题请在客户端处理' : ''}${job.releaseStatus === 'releasing' ? ' · 正在释放网页连接' : job.releaseStatus === 'released' ? ' · 网页连接已释放' : job.releaseStatus === 'failed' ? ' · 会话释放失败，请检查服务进程' : ''}` : session.managed ? session.status === 'preparing' ? '正在准备上下文，准备完成后即可发送。' : session.contextSourceDeviceId && session.contextSourceDeviceId !== 'local' && !session.contextTransferred ? '上下文来源已记录，首次发送时将在来源设备读取并准备。' : '上下文已准备，首次发送时交给 Agent 读取。' : canSendNative ? session.deviceId && session.deviceId !== 'local' ? '消息将在目标设备追加到原会话；设备离线时排队等待，历史区域仅显示已同步片段。' : '消息将追加到原会话，沿用其上下文与配置。' : '此会话无法直接续聊，可带上下文新开会话。';
  return <>{outputHost && createPortal(<LiveMessages messages={pending} />, outputHost)}<section className="history-composer" id="historyComposer" aria-label="会话输入框">
    {!canEdit ? <p className="history-meta">只读成员无法发送消息或新开会话。</p> : <><div className="conversation-switch tc-create-shell">
      <div className={styles.modeHeader}>
        <strong>{newSessionMode ? '带上下文新开会话' : '当前会话'}</strong>
        {newSessionMode ? <button type="button" className={styles.modeAction} disabled={configurationDisabled} onClick={() => { setNewSessionMode(false); setNewStatus(''); }}>返回当前会话</button> : <button type="button" className={styles.modeAction} disabled={configurationDisabled} onClick={() => { setNewSessionMode(true); setNewStatus(''); }}>带上下文新开会话 →</button>}
      </div>
      {newSessionMode ? <><p className={styles.modeHint}>为新会话选择运行配置。可直接创建，也可输入第一条消息后创建并发送。</p><div className="tc-create-context" aria-label="新会话运行环境">
      {targets.isPending ? <p className="tc-create-hint" role="status">正在读取运行配置…</p> : targets.isError ? <p role="alert">{errorMessage(targets.error)}</p> : project ? <>
        <DismissibleDetails className="tc-config-menu tc-directory-menu" name="create-config"><summary aria-label={`工作目录：${cwd || project.cwd || '默认目录'}`}>▱ <span>{runDirectoryName(cwd || project.cwd || '')}</span><span aria-hidden="true">⌄</span></summary><div className="tc-config-panel"><label className="tc-create-setting">工作目录<input value={cwd} onChange={event => { setCwd(event.target.value); setDirectoryRequestId(''); }} placeholder={project.cwd || '输入工作目录'} maxLength={2000} disabled={configurationDisabled} /></label><div className="tc-actions"><button type="button" className="button secondary" disabled={configurationDisabled} onClick={() => void chooseDirectory()}>选择目录</button><button type="button" className="button ghost" disabled={configurationDisabled} onClick={() => { setCwd(project.cwd); setDirectoryRequestId(''); }}>使用默认目录</button></div>{!!project.commonDirectories?.length && <div className="tc-directory-options">{project.commonDirectories.slice(0, 4).map(path => <button key={path} type="button" disabled={configurationDisabled} onClick={() => { setCwd(path); setDirectoryRequestId(''); }}>{runDirectoryName(path)}<small>{path}</small></button>)}</div>}</div></DismissibleDetails>
        <label className="tc-target-control">▣ <select aria-label="执行位置" value={index} disabled={configurationDisabled} onChange={event => { setSelectedTarget(projectIdentity(projects[Number(event.target.value)]!)); setCwd(''); setDirectoryRequestId(''); setModel(''); setEffort(''); }}>{projects.map((item, at) => <option key={`${item.deviceId}:${item.id}`} value={at}>{item.name} · {item.deviceName}{item.online ? '' : '（离线）'}</option>)}</select></label>
        <DismissibleDetails className="tc-config-menu tc-branch-menu" name="create-config" onToggle={event => { if (event.currentTarget.open && !branchBusy) void branchQuery.refetch(); }}><summary aria-label="Git 分支">⑂ <span>{branch?.repository ? branch.current || '分离 HEAD' : branchBusy ? '读取分支…' : branchError ? '分支读取失败' : branch ? '非 Git 目录' : 'Git 分支'}</span><span aria-hidden="true">⌄</span></summary><div className="tc-config-panel">{branchBusy ? <p role="status">正在处理分支…</p> : branchError ? <p role="alert">{branchError}</p> : branch?.repository ? <><input aria-label="搜索分支" value={branchSearch} onChange={event => setBranchSearch(event.target.value)} placeholder="搜索分支" /><p className="tc-create-hint">当前：{branch.current || '分离 HEAD'} · 未提交：{branch.changes} 项</p><div className="tc-branch-options">{branch.branches.filter(name => name.toLowerCase().includes(branchSearch.toLowerCase())).map(name => <button key={name} type="button" disabled={configurationDisabled} aria-pressed={name === branch.current} onClick={() => void branchAction('switch', name)}>{name}{name === branch.current ? ' ✓' : ''}</button>)}</div><label className="tc-create-setting">新分支<input aria-label="新分支名称" value={newBranch} onChange={event => setNewBranch(event.target.value)} maxLength={200} disabled={configurationDisabled} /></label><button type="button" className="button secondary" disabled={configurationDisabled || !newBranch.trim()} onClick={() => void branchAction('create', newBranch.trim())}>创建并切换</button></> : <p className="tc-create-hint">当前目录不是 Git 仓库。</p>}</div></DismissibleDetails>
      </> : <p role="alert" className="tc-create-hint">{selectedTarget ? '已选执行位置当前不可用，请重新选择。' : targets.data?.localError || '没有可用 Agent'}{selectedTarget && <button type="button" className="button secondary" disabled={configurationDisabled} onClick={() => { setSelectedTarget(null); setCwd(''); setDirectoryRequestId(''); setModel(''); setEffort(''); }}>重新选择执行位置</button>}</p>}</div></> : <div className={styles.currentConfig} aria-label="当前会话配置">
        <span title={session.cwd}>▱ {runDirectoryName(session.cwd)}</span><span>▣ {session.agentLabel || session.agent} · {currentDevice}</span>{session.branch && <span>⑂ {session.branch}</span>}<span>{currentModel}</span>
      </div>}
      <form className="conversation-composer" onSubmit={submit}><label className="history-sr-only" htmlFor="historyReply">{newSessionMode ? '新会话首条消息（可选）' : '发送消息'}</label><textarea id="historyReply" rows={3} maxLength={12000} placeholder={newSessionMode ? '输入新会话的第一条消息，也可以留空后创建…' : '继续讨论，或描述下一步需要完成的工作…'} value={text} onChange={event => updateText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} disabled={send.isPending || creating || disabled} required={!newSessionMode} />
        <div className="history-compose-footer"><div className="tc-create-tools">{!newSessionMode && session.agent === 'codex' && (!session.deviceId || session.deviceId === 'local') && session.sessionId && <a className="conversation-context" href={`codex://threads/${encodeURIComponent(session.sessionId)}`}>在 Codex 中打开 ↗</a>}<span className="history-meta">⌘ / Ctrl + Enter</span></div><div className="tc-create-send">
          {newSessionMode ? <>{project && <ModelEffortMenu project={project} model={model} effort={effort} disabled={configurationDisabled} onModelChange={setModel} onEffortChange={setEffort} />}<button type="submit" className={styles.createButton} disabled={!canCreate}>{creating ? '正在创建…' : text.trim() ? '创建并发送' : '创建会话'}</button></> : <button type="submit" aria-label="发送消息" title="发送消息" disabled={!canSend}>↑</button>}
        </div></div>{newSessionMode && <p className="conversation-new-status" role="status">{creating ? '正在带上上下文…' : newStatus || (latestCreation?.status === 'error' ? `${errorMessage(latestCreation.error)}。再次点击可重试，输入已保留。` : '')}</p>}
      </form></div><p className="history-meta" role="status">{statusText}</p>{status.isError && <p role="alert">{errorMessage(status.error)}</p>}{error && <p role="alert">{error}</p>}
      <div className="history-compose-actions">{job && <>{['queued', 'running', 'waiting'].includes(job.status) && <button type="button" disabled={control.isPending} onClick={() => control.mutate({ executionId: job.id, action: 'stop' })}>停止</button>}{job.status === 'waiting' && job.request && <button type="button" onClick={() => setResponding(true)}>处理请求</button>}{job.status === 'unknown' && <button type="button" disabled={control.isPending} onClick={() => control.mutate({ executionId: job.id, action: 'reconcile' })}>核对结果</button>}{!busy.has(job.status) && <button type="button" onClick={() => { void syncHistory(session.id).catch(failure => setError(errorMessage(failure))); void queryClient.invalidateQueries({ queryKey: ['history', 'detail', session.id] }); }}>刷新原始记录</button>}{['failed', 'interrupted', 'blocked'].includes(job.status) && <><button type="button" onClick={() => updateText(job.prompt)}>重新编辑本轮消息</button><button type="button" onClick={() => void navigator.clipboard.writeText(job.prompt).catch(() => setError('无法自动复制，请使用输入框中的文本。'))}>复制本轮消息</button></>}</>}</div>
    </>}
    {canEdit && responding && job?.request && <div className={overlayStyles.backdrop}><div className={`tc-dialog ${overlayStyles.panel}`} role="dialog" aria-modal="true" aria-label="回复 Agent 请求"><form onSubmit={event => { event.preventDefault(); const questions = job.request?.method === 'item/tool/requestUserInput' ? job.request.params?.questions : undefined; control.mutate({ executionId: job.id, action: 'respond', ...(questions ? { answers: Object.fromEntries(questions.map(question => [question.id, answers[question.id] || ''])) } : { decision }) }); }}><h2>回复 Agent 请求</h2>{job.request.method === 'item/tool/requestUserInput' ? job.request.params?.questions?.map(question => <label key={question.id}>{question.question}{question.options?.length && <p>{question.options.map(option => `${option.label}：${option.description || ''}`).join('；')}</p>}<textarea required maxLength={12000} value={answers[question.id] || ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} /></label>) : <><pre>{String(job.request.params?.command || JSON.stringify(job.request.params, null, 2))}</pre><label>本次操作<select value={decision} onChange={event => setDecision(event.target.value)}><option value="decline">拒绝</option><option value="accept">允许本次操作</option></select></label></>}{error && <p role="alert">{error}</p>}<button type="button" disabled={control.isPending} onClick={() => setResponding(false)}>取消</button><button type="submit" disabled={control.isPending}>发送回复</button></form></div></div>}
  </section></>;
}
