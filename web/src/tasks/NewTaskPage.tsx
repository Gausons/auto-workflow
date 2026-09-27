import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiRequest, hasSessionToken } from '../api/client.js';
import { runDirectoryName, runEffortLabel } from '../../../public/agentRunConfig.js';
import type { AgentProject, TaskCenterData } from '../../../public/taskTypes.js';

interface Targets { projects: AgentProject[]; localError?: string }
interface BranchState { repository: boolean; current?: string; changes: number; branches: string[] }
interface DirectoryResult { status: 'pending' | 'selecting' | 'completed' | 'cancelled' | 'failed'; requestId: string; cwd?: string; message?: string }
interface Created { taskId: string; revision?: number }
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const route = () => location.pathname === '/tasks/new' || location.hash === '#new-task';
let requestedSourceId: string | null = null;
export function rememberSourceSession(id: string) { requestedSourceId = id; }

async function encodeFile(file: File) {
  return new Promise<{ name: string; data: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(',')[1] || '' });
    reader.readAsDataURL(file);
  });
}

async function pickDirectory(project: AgentProject) {
  const response = await apiRequest<DirectoryResult>('/api/task-center/directory-picker', {
    method: 'POST', body: JSON.stringify({ deviceId: project.deviceId, projectId: project.id })
  });
  if (response.status === 'completed') return response.cwd || '';
  for (let attempt = 0; attempt < 300; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result = await apiRequest<DirectoryResult>(`/api/task-center/directory-picker?requestId=${encodeURIComponent(response.requestId)}`);
    if (result.status === 'completed') return result.cwd || '';
    if (result.status === 'cancelled') throw new Error('已取消选择目录');
    if (result.status === 'failed') throw new Error(result.message || '无法选择目录');
  }
  throw new Error('等待目录选择超时');
}

export function NewTaskPage() {
  const [active, setActive] = useState(route);
  const [sourceSessionId, setSourceSessionId] = useState<string | null>(() => requestedSourceId);
  const [content, setContent] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [projectIndex, setProjectIndex] = useState(0);
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [branch, setBranch] = useState<BranchState | null>(null);
  const [branchError, setBranchError] = useState('');
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchSearch, setBranchSearch] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ taskId: string; content: string; executed: boolean }[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();
  useEffect(() => {
    const update = () => setActive(route());
    const fromSession = (event: Event) => {
      const id = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (id) { rememberSourceSession(id); setSourceSessionId(id); }
    };
    window.addEventListener('hashchange', update);
    window.addEventListener('bugflow:create-task-from-session', fromSession);
    return () => { window.removeEventListener('hashchange', update); window.removeEventListener('bugflow:create-task-from-session', fromSession); };
  }, []);
  const targets = useQuery({ queryKey: ['task-center', 'targets'], queryFn: ({ signal }) => apiRequest<Targets>('/api/task-center/codex', { signal }), enabled: active && hasSessionToken(), retry: false });
  const snapshot = useQuery({ queryKey: ['task-center', 'snapshot'], queryFn: ({ signal }) => apiRequest<TaskCenterData>('/api/task-center', { signal }), enabled: active && hasSessionToken() });
  const identity = useQuery({ queryKey: ['task-center', 'identity'], queryFn: ({ signal }) => apiRequest<{ permissions: string[] }>('/api/bootstrap', { signal }), enabled: active && hasSessionToken() });
  const project = targets.data?.projects[projectIndex];
  const selectedModel = project?.models?.find(item => item.id === (model || project.defaultModel));
  const efforts = selectedModel?.reasoningEfforts || project?.reasoningEfforts || [];
  const busy = branchBusy || picking;
  const create = useMutation({
    retry: false,
    mutationFn: async () => {
      const description = content.trim();
      if (!description) throw new Error('请输入任务描述');
      if (files.length && project?.deviceId !== 'local') throw new Error('附件暂仅支持工作台所在设备，请移除附件或切回本地');
      const attachments = await Promise.all(files.map(encodeFile));
      const task = await apiRequest<Created>('/api/task-center', { method: 'POST', body: JSON.stringify({ action: 'create', content: description, sessionId: sourceSessionId }) });
      let executed = false;
      let executionError = '';
      if (project) {
        try {
          await apiRequest('/api/task-center/execute', { method: 'POST', body: JSON.stringify({ taskId: task.taskId, revision: task.revision || 1, attachments, projectId: project.id, cwd: cwd.trim(), model, reasoningEffort: effort, deviceId: project.deviceId }) });
          executed = true;
        } catch (failure) { executionError = `任务已创建，但 Agent 启动失败：${errorMessage(failure)}`; }
      }
      return { taskId: task.taskId, content: description, executed, executionError };
    },
    onSuccess: result => {
      setCreated(previous => [...previous, result]);
      setError(result.executionError);
      setContent(''); setFiles([]); setSourceSessionId(null); requestedSourceId = null; setCwd('');
      void queryClient.invalidateQueries({ queryKey: ['task-center', 'snapshot'] });
      window.dispatchEvent(new CustomEvent('bugflow:open-task', { detail: { taskId: result.taskId, source: 'create', warning: result.executionError } }));
    },
    onError: failure => setError(errorMessage(failure))
  });
  useEffect(() => {
    if (!sourceSessionId || !snapshot.data || content.trim()) return;
    setContent(snapshot.data.sessions.find(item => item.id === sourceSessionId)?.title || '');
  }, [sourceSessionId, snapshot.data]);
  useEffect(() => { setBranch(null); setBranchError(''); }, [project?.id, project?.deviceId, cwd]);
  async function loadBranches(action: 'list' | 'switch' | 'create' = 'list', name = '') {
    if (!project || branchBusy) return;
    setBranchBusy(true); setBranchError('');
    try {
      const result = await apiRequest<BranchState>('/api/task-center/git', { method: 'POST', body: JSON.stringify({ action, branch: name, projectId: project.id, deviceId: project.deviceId, cwd }) });
      setBranch(result);
      if (action === 'create') setNewBranch('');
    } catch (failure) { setBranchError(errorMessage(failure)); }
    finally { setBranchBusy(false); }
  }
  async function chooseDirectory() {
    if (!project || picking) return;
    setPicking(true); setError('');
    try { setCwd(await pickDirectory(project)); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setPicking(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!create.isPending && !busy && identity.data?.permissions.includes('work.execute')) { setError(''); create.mutate(); }
  }
  if (!active) return null;
  const canEdit = identity.data?.permissions.includes('work.execute') === true;
  const blocked = create.isPending || busy;
  return <>
    <header className="tc-heading"><div><p className="eyebrow">跨设备 · 跨 Agent</p><h1>新建任务</h1></div><a className="button secondary" href="#tasks">返回任务中心</a></header>
    {!canEdit && !identity.isPending ? <p role="alert">当前账号没有创建任务权限。</p> : null}
    <section className="tc-create" aria-label="新建任务会话"><div className="tc-create-log" role="log" aria-live="polite">
      {created.length ? created.map(item => <div key={item.taskId}><p className="tc-create-message">{item.content}</p><div className="tc-create-reply">{item.executed ? '任务已创建并提交 Agent。' : '任务已创建。'}<a className="button secondary" href="#tasks" onClick={() => window.dispatchEvent(new CustomEvent('bugflow:open-task', { detail: { taskId: item.taskId } }))}>查看任务</a></div></div>) : <div className="tc-empty"><h2>想让 Agent 完成什么？</h2><p>描述你的目标，让 Agent 帮你完成。</p></div>}
    </div><form className="tc-create-shell" aria-busy={blocked} onSubmit={submit}>
      <div className="tc-create-context" aria-label="任务运行环境">
        {targets.isPending ? <p className="tc-create-hint" role="status">正在读取运行配置…</p> : targets.isError ? <p role="alert">{errorMessage(targets.error)}</p> : project ? <>
          <details className="tc-config-menu tc-directory-menu" name="create-config"><summary aria-label={`工作目录：${cwd || project.cwd || '默认目录'}`}>▱ <span>{runDirectoryName(cwd || project.cwd || '')}</span><span className="tc-config-chevron" aria-hidden="true">⌄</span></summary><div className="tc-config-panel">
            <label className="tc-create-setting">工作目录<input aria-label="工作目录" value={cwd} onChange={event => setCwd(event.target.value)} placeholder={project.cwd || '输入工作目录'} maxLength={2000} disabled={blocked} /></label>
            <div className="tc-actions"><button className="button secondary" type="button" disabled={blocked} onClick={() => void chooseDirectory()}>选择目录</button><button className="button ghost" type="button" disabled={blocked} onClick={() => setCwd('')}>使用默认目录</button></div>
            {!!project.commonDirectories?.length && <><p className="tc-create-hint">常用目录</p><div className="tc-directory-options">{project.commonDirectories.slice(0, 4).map(path => <button key={path} type="button" title={path} aria-label={path} aria-pressed={path === cwd} disabled={blocked} onClick={() => setCwd(path)}>▱ <span>{runDirectoryName(path)}<small>{path}</small></span></button>)}</div></>}
          </div></details>
          <label className="tc-target-control" title="执行位置">▣ <select aria-label="执行位置" value={projectIndex} disabled={blocked} onChange={event => { setProjectIndex(Number(event.target.value)); setCwd(''); setModel(''); setEffort(''); }}>{targets.data?.projects.map((item, index) => <option key={`${item.deviceId}:${item.id}`} value={index}>{item.name} · {item.deviceName}{item.online ? '' : '（离线）'}</option>)}</select></label>
          {project.deviceId === 'local' && <details className="tc-config-menu tc-branch-menu" name="create-config" onToggle={event => { if (event.currentTarget.open && !branch && !branchBusy) void loadBranches(); }}><summary aria-label="Git 分支">⑂ <span>{branch?.current || 'Git 分支'}</span><span aria-hidden="true">⌄</span></summary><div className="tc-config-panel">
            {branchBusy ? <p role="status">正在处理分支…</p> : branchError ? <p role="alert">{branchError}</p> : branch?.repository ? <><input aria-label="搜索分支" value={branchSearch} onChange={event => setBranchSearch(event.target.value)} placeholder="搜索分支" /><p className="tc-create-hint">当前：{branch.current || '分离 HEAD'} · 未提交：{branch.changes} 项</p><div className="tc-branch-options">{branch.branches.filter(name => name.toLowerCase().includes(branchSearch.toLowerCase())).map(name => <button key={name} type="button" disabled={blocked} aria-pressed={name === branch.current} onClick={() => void loadBranches('switch', name)}>{name}{name === branch.current ? ' ✓' : ''}</button>)}</div><label className="tc-create-setting">新分支<input aria-label="新分支名称" value={newBranch} onChange={event => setNewBranch(event.target.value)} maxLength={200} /></label><button type="button" className="button secondary" disabled={blocked || !newBranch.trim()} onClick={() => void loadBranches('create', newBranch.trim())}>创建并切换</button></> : <p className="tc-create-hint">当前目录不是 Git 仓库。</p>}
          </div></details>}
        </> : <p className="tc-create-hint" role="alert">{targets.data?.localError || '未发现可用 Agent，仍可创建任务。'}</p>}
      </div>
      <div className="tc-composer conversation-composer">
        {sourceSessionId && <p className="tc-meta">将关联会话：{snapshot.data?.sessions.find(item => item.id === sourceSessionId)?.title || sourceSessionId}</p>}
        <textarea ref={messageInput} aria-label="任务描述" value={content} onChange={event => setContent(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="描述任务、期望结果，或需要解决的问题…" rows={4} maxLength={64000} required disabled={blocked || !canEdit} />
        <div className="tc-attachment-list">{files.map((file, index) => <span className="tc-attachment" key={`${file.name}:${index}`} title={file.name}><span>{file.name}</span><small>{Math.max(1, Math.round(file.size / 1024))} KB</small><button type="button" aria-label={`移除 ${file.name}`} disabled={blocked} onClick={() => setFiles(current => current.filter((_, at) => at !== index))}>×</button></span>)}</div>
        <input ref={fileInput} type="file" multiple hidden onChange={event => { const next = [...files, ...Array.from(event.target.files || [])]; if (next.length > 10 || next.some(file => file.size > 5 * 1024 * 1024) || next.reduce((total, file) => total + file.size, 0) > 10 * 1024 * 1024) setError('最多 10 个附件，单个不超过 5 MB，总计不超过 10 MB'); else { setFiles(next); setError(''); } event.target.value = ''; }} />
        <footer><div className="tc-create-tools"><button className="tc-attach-button" type="button" aria-label="附加文件" disabled={blocked || project?.deviceId !== 'local'} onClick={() => fileInput.current?.click()}>＋</button><span className="tc-create-shortcut">⌘ / Ctrl + Enter 发送</span></div><div className="tc-create-send">
          {project && <details className="tc-config-menu tc-model-menu" name="create-config"><summary aria-label="模型与思考强度"><span>{selectedModel?.name || model || project.defaultModel || '默认模型'}</span><span className="tc-effort-label">{runEffortLabel(effort || selectedModel?.defaultReasoningEffort || project.defaultReasoningEffort || '') || '默认'}</span><span aria-hidden="true">⌄</span></summary><div className="tc-config-panel"><label className="tc-create-setting">模型<select aria-label="模型" value={model} disabled={blocked} onChange={event => { setModel(event.target.value); setEffort(''); }}><option value="">默认模型{project.defaultModel ? `（${project.defaultModel}）` : ''}</option>{project.models?.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select></label><label className="tc-create-setting">思考强度<select aria-label="思考强度" value={effort} disabled={blocked} onChange={event => setEffort(event.target.value)}><option value="">默认强度{selectedModel?.defaultReasoningEffort || project.defaultReasoningEffort ? `（${selectedModel?.defaultReasoningEffort || project.defaultReasoningEffort}）` : ''}</option>{efforts.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select></label><p className="tc-create-hint">{selectedModel?.description || '默认选项沿用所选 Agent 的配置。'}</p></div></details>}
          <button className="button primary" type="submit" aria-label="创建并发送任务" disabled={blocked || !canEdit || !content.trim()}>{create.isPending ? '…' : '↑'}</button>
        </div></footer>{error && <p className="tc-form-error" role="alert">{error}</p>}
      </div>
    </form></section>
  </>;
}
