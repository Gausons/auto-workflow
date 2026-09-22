import { escape, renderMessages } from './historyView.js';
import { pendingHistoryMessages } from './historyTimeline.js';
import { renderRunContext, renderRunModel, selectedAgentProject, type AgentRunConfig } from './agentRunConfig.js';
import type { AgentProject, HistoryMessage, InteractionRequest } from './taskTypes.js';

interface ComposerSession {
  id: string; agent: string; agentLabel?: string; deviceId?: string; sessionId?: string | null;
  archived?: boolean; managed?: boolean; model?: string; cwd?: string;
}
interface ComposerJob {
  id: string; status: string; prompt: string; message?: string; output?: string; turnId?: string | null;
  conversationId?: string; createdAt?: string; releaseStatus?: string; executionTransport?: string;
  request?: InteractionRequest | null;
}
interface ComposerOptions {
  api(path: string, init?: RequestInit): Promise<unknown>;
  canEdit(): boolean;
  refresh(id: string): unknown;
  syncHistory?: (id: string) => Promise<HistoryMessage[] | null>;
  openSession?: (id: string) => Promise<unknown> | unknown;
}
interface StatusResponse { execution?: ComposerJob | null; executions?: ComposerJob[] }
interface ExecutionResponse { executionId: string }
interface NewSessionResponse { sessionId: string }
interface TargetsResponse { projects: AgentProject[]; localError?: string }
interface BranchState { repository: boolean; current?: string; changes: number; branches: string[] }
interface DirectoryPickerResult { status: 'pending' | 'selecting' | 'completed' | 'cancelled' | 'failed'; requestId: string; cwd?: string; message?: string }
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const requestId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const busy = new Set(['queued', 'launching', 'running', 'waiting', 'unknown']);
const names: Record<string, string> = { blocked: '会话被占用 · 未发送', queued: '等待执行', launching: '正在连接 Agent', running: '正在回复', waiting: '等待你处理', completed: '本轮完成', failed: '执行失败', interrupted: '已停止', unknown: '结果待核对' };

export function createHistoryComposer({ api, canEdit, refresh, syncHistory, openSession }: ComposerOptions) {
  let canSendNative = false;
  const newRequests = new Map<string, { signature: string; requestId: string }>();
  const restoredConflicts = new Set<string>();
  const drafts = new Map<string, { text: string; requestId: string; sentText: string }>();
  let liveOutput: HTMLElement | null = null;
  let historyMessages: HistoryMessage[] = [], executions: ComposerJob[] = [];
  let newSessionConfig: AgentRunConfig | null = null, newSessionStatus = '', branchState: BranchState | null = null, branchLoading = false, branchError = '';
  let submission = 0, synchronizedSignature = '';
  let host: HTMLElement | null = null, session: ComposerSession | null = null, generation = 0, timer: ReturnType<typeof setTimeout> | undefined, sending = false, polling = false, job: ComposerJob | null = null, outputSignature = '';
  const draft = () => { if (!session) throw new Error('会话尚未挂载'); if (!drafts.has(session.id)) drafts.set(session.id, { text: '', requestId: '', sentText: '' }); return drafts.get(session.id)!; };
  const select = <T extends HTMLElement = HTMLElement>(selector: string): T | null => host?.querySelector<T>(selector) || null;
  function update() {
    const submit = select<HTMLButtonElement>('[type="submit"]'), input = select<HTMLTextAreaElement>('textarea');
    if (submit) submit.disabled = !canSendNative || sending || (Boolean(job && busy.has(job.status)) || job?.releaseStatus === 'releasing') || !input?.value.trim();
    if (input) input.disabled = sending;
    const status = select('[data-status]');
    if (status) status.textContent = sending ? '正在发送…' : job ? `${names[job.status] || job.status} · ${job.message || ''}${job.executionTransport === 'desktop-ipc' ? ' · 由客户端执行；审批和问题请在客户端处理' : ''}${job.releaseStatus === 'releasing' ? ' · 正在释放网页连接' : job.releaseStatus === 'released' ? ' · 网页连接已释放' : job.releaseStatus === 'failed' ? ' · 会话释放失败，请检查服务进程' : ''}` : session?.managed ? '已继承原会话上下文，直接输入下一条消息即可。' : canSendNative ? '消息将追加到原会话，沿用其上下文与配置。' : '选择其他 Agent 新开会话，即可带上上下文继续。';
    const actions = select('[data-actions]');
    if (actions) actions.innerHTML = job ? `${job.id && ['queued', 'running', 'waiting'].includes(job.status) ? '<button type="button" data-control="stop">停止</button>' : ''}${job.status === 'waiting' && job.request ? '<button type="button" data-control="respond">处理请求</button>' : ''}${job.status === 'unknown' ? '<button type="button" data-control="reconcile">核对结果</button>' : ''}${!busy.has(job.status) ? '<button type="button" data-refresh>刷新原始记录</button>' : ''}${['failed', 'interrupted', 'blocked'].includes(job.status) ? '<button type="button" data-restore>重新编辑本轮消息</button><button type="button" data-copy>复制本轮消息</button>' : ''}` : '';
    const output = liveOutput;
    const messages = pendingHistoryMessages(historyMessages, executions);
    const signature = JSON.stringify(messages);
    if (output && signature !== outputSignature) {
      const scroll = output.closest('.history-chat-scroll');
      const follow = scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
      output.innerHTML = messages.length ? renderMessages(messages) : '';
      if (follow && scroll) scroll.scrollTop = scroll.scrollHeight;
      outputSignature = signature;
    }
  }
  async function poll() {
    if (!host || !session || polling) return;
    const current = generation, id = session.id, revision = submission; polling = true;
    try { const result = await api(`/api/agent-sessions/${id}/continue`) as StatusResponse; if (current !== generation || revision !== submission || sending) return;
      const resultExecutions = result.executions || (result.execution ? [result.execution] : []);
      const signature = JSON.stringify(resultExecutions);
      const snapshot = syncHistory && signature !== synchronizedSignature ? await syncHistory(id) : null;
      if (current !== generation || revision !== submission || sending) return;
      if (snapshot) historyMessages = snapshot;
      job = result.execution ?? null; executions = resultExecutions;
      if (!executions.some(item => busy.has(item.status)) && !pendingHistoryMessages(historyMessages, executions).length) synchronizedSignature = signature;
      if (job?.status === 'blocked' && !restoredConflicts.has(job.id)) {
        const state = draft(); if (!state.text.trim()) { state.text = job.prompt; state.requestId = ''; select<HTMLTextAreaElement>('textarea')!.value = state.text; }
        restoredConflicts.add(job.id);
      }
      update(); }
    catch (error: unknown) { const target = select('[data-error]'); if (current === generation && target) target.textContent = errorMessage(error); }
    finally { if (current === generation) { polling = false; timer = setTimeout(poll, 2500); } }
  }
  function unmount() { generation++; clearTimeout(timer); host = null; liveOutput = null; session = null; polling = false; sending = false; job = null; historyMessages = []; executions = []; synchronizedSignature = ''; outputSignature = ''; newSessionConfig = null; newSessionStatus = ''; branchState = null; branchLoading = false; branchError = ''; }
  function mount(element: HTMLElement, value: ComposerSession, output?: HTMLElement, messages: HistoryMessage[] = []) {
    unmount(); host = element; liveOutput = output || null; session = value; historyMessages = messages;
    canSendNative = Boolean(value.managed || (value.agent === 'codex' && (!value.deviceId || value.deviceId === 'local') && value.sessionId && !value.archived));
    if (!canEdit()) {
      host.innerHTML = `<p class="history-meta">${!canEdit() ? '只读成员无法发送消息。' : value.archived ? '请先在 Codex 客户端取消归档，再继续此会话。' : '此 Agent 暂不支持网页原会话续聊，请在对应客户端继续。'}</p>`; return;
    }
    const state = draft();
    const contextLink = value.agent === 'codex' && value.sessionId ? `<a class="conversation-context" href="codex://threads/${encodeURIComponent(value.sessionId)}">在 Codex 中打开 ↗</a>` : `<span class="conversation-context">${escape(value.agentLabel || value.agent)} · ${escape(value.model || '默认配置')}</span>`;
    host.innerHTML = `<form class="conversation-composer"><label class="history-sr-only" for="historyReply">发送消息</label><textarea id="historyReply" rows="3" maxlength="12000" placeholder="继续讨论，或描述下一步需要完成的工作…" required>${escape(state.text)}</textarea><div class="history-compose-footer">${contextLink}<span class="conversation-send"><span class="history-meta">⌘ / Ctrl + Enter</span><button type="submit" aria-label="发送消息" title="发送消息">↑</button></span></div></form><p class="history-meta" data-status role="status"></p><p data-error role="alert"></p><div data-actions></div>`;
    select<HTMLTextAreaElement>('textarea')!.oninput = (event: Event) => { state.text = (event.target as HTMLTextAreaElement).value; if (state.text.trim() !== state.sentText) state.requestId = ''; update(); };
    select<HTMLTextAreaElement>('textarea')!.onkeydown = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); if (!select<HTMLButtonElement>('[type="submit"]')!.disabled) select<HTMLFormElement>('form')!.requestSubmit(); } };
    select<HTMLFormElement>('form')!.onsubmit = async (e: SubmitEvent) => {
      e.preventDefault(); if (!canSendNative || sending || (Boolean(job && busy.has(job.status)) || job?.releaseStatus === 'releasing') || !state.text.trim()) return;
      const current = generation, id = value.id, message = state.text.trim(), createdAt = new Date().toISOString();
      state.requestId ||= requestId(); state.sentText = message;
      submission++; sending = true; select('[data-error]')!.textContent = ''; update();
      try {
        const result = await api(`/api/agent-sessions/${id}/continue`, { method: 'POST', body: JSON.stringify({ message, requestId: state.requestId }) }) as ExecutionResponse;
        if (state.text.trim() === message) state.text = ''; state.requestId = '';
        if (current === generation) { select<HTMLTextAreaElement>('textarea')!.value = state.text; job = { id: result.executionId, turnId: value.managed ? result.executionId : undefined, createdAt, status: 'queued', prompt: message, message: value.managed ? '已提交到当前会话' : '已提交到原会话' }; executions = [...executions.filter(item => item.id !== job!.id), job]; }
      } catch (error: unknown) { if (current === generation) select('[data-error]')!.textContent = `${errorMessage(error)}。输入已保留；再次发送相同内容不会重复提交。`; }
      finally { if (current === generation) { sending = false; update(); } }
    };
    host.onclick = async (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest('button'); if (!target) return;
      const activeJob = job;
      if (target.hasAttribute('data-copy')) { if (!activeJob) return; try { await navigator.clipboard.writeText(activeJob.prompt); } catch { select('[data-error]')!.textContent = '无法自动复制，请使用输入框中的文本。'; } return; }
      if (target.hasAttribute('data-refresh')) { refresh(value.id); return; }
      if (target.hasAttribute('data-restore')) { if (!activeJob) return; state.text = activeJob.prompt; state.requestId = ''; select<HTMLTextAreaElement>('textarea')!.value = state.text; update(); select<HTMLTextAreaElement>('textarea')!.focus(); return; }
      const action = target.dataset.control; if (!action || !job?.id) return;
      if (action === 'respond') { respond(); return; }
      const current = generation; target.disabled = true;
      try { await api('/api/task-center/execution-action', { method: 'POST', body: JSON.stringify({ executionId: job.id, action }) }); }
      catch (error: unknown) { if (current === generation) select('[data-error]')!.textContent = errorMessage(error); }
      finally { target.disabled = false; }
    };
    mountSwitch();
    update(); if (canSendNative) void poll();
  }
  function mountSwitch() {
    if (!host || !session || !openSession) return;
    const currentSession = session, current = generation, id = currentSession.id, container = document.createElement('div');
    container.className = 'conversation-switch tc-create-shell';
    container.innerHTML = '<div class="tc-create-context"><p class="tc-create-hint" role="status">正在读取运行配置…</p></div>';
    host.prepend(container);
    const project = () => newSessionConfig ? selectedAgentProject(newSessionConfig) : undefined;
    const branchMenu = () => project()?.deviceId !== 'local' ? '' : `<details class="tc-config-menu tc-branch-menu" id="history-branch-menu" name="create-config"><summary data-new-session="branches" aria-label="Git 分支"><span aria-hidden="true">⑂</span><span>${escape(branchState?.current || 'Git 分支')}</span><span aria-hidden="true">⌄</span></summary><div class="tc-config-panel">${branchLoading ? '<p role="status">正在读取分支…</p>' : branchError ? `<p role="alert">${escape(branchError)}</p>` : branchState?.repository ? `<input data-new-session="branch-search" aria-label="搜索分支" placeholder="搜索分支"><p class="tc-create-hint">${branchState.current ? `当前：${escape(branchState.current)}` : '当前为分离 HEAD'} · 未提交：${branchState.changes} 项</p><div class="tc-branch-options">${branchState.branches.map(name => `<button type="button" data-new-session="switch-branch" data-id="${escape(name)}" aria-pressed="${name === branchState?.current}">${escape(name)}${name === branchState?.current ? ' ✓' : ''}</button>`).join('')}</div><label class="tc-create-setting">新分支<input data-new-session="new-branch-name" aria-label="新分支名称" placeholder="输入分支名称" maxlength="200"></label><button type="button" class="button secondary" data-new-session="new-branch">创建并切换</button>` : '<p class="tc-create-hint">展开后读取当前 Git 分支。</p>'}</div></details>`;
    const renderSwitch = () => {
      if (current !== generation || !newSessionConfig) return;
      container.innerHTML = `<div class="tc-create-context" aria-label="新会话运行环境">${renderRunContext(newSessionConfig, { disabled: sending, branch: branchMenu() })}</div><div class="conversation-new-actions">${renderRunModel(newSessionConfig, sending)}<button type="button" class="button secondary" data-new-session="create" ${sending ? 'disabled' : ''}>带上下文新开会话 →</button><span role="status">${escape(newSessionStatus)}</span></div>`;
    };
    void api('/api/task-center/codex').then(value => {
      const result = value as TargetsResponse;
      if (current !== generation) return;
      const projects = result.projects.filter(item => item.deviceId === (currentSession.deviceId || 'local'));
      const matching = projects.findIndex(item => item.cwd === currentSession.cwd && (item.agent || 'codex') === currentSession.agent);
      newSessionConfig = { projects, projectIndex: Math.max(0, matching), cwd: '', model: '', reasoningEffort: '' };
      if (!projects.length) newSessionStatus = result.localError || '来源设备上没有可用 Agent';
      renderSwitch();
    }).catch((error: unknown) => { if (current === generation) { newSessionStatus = errorMessage(error); newSessionConfig = { projects: [], projectIndex: 0, cwd: '', model: '', reasoningEffort: '' }; renderSwitch(); } });
    container.oninput = event => {
      if (!newSessionConfig) return;
      const target = event.target as HTMLInputElement;
      if (target.id === 'tc-create-cwd') newSessionConfig.cwd = target.value;
      if (target.dataset.newSession === 'branch-search') container.querySelectorAll<HTMLElement>('[data-new-session="switch-branch"]').forEach(button => { button.hidden = !(button.dataset.id || '').toLowerCase().includes(target.value.toLowerCase()); });
    };
    container.onchange = event => {
      if (!newSessionConfig) return;
      const target = event.target as HTMLSelectElement;
      if (target.id === 'tc-create-project') { newSessionConfig.projectIndex = Number(target.value) || 0; newSessionConfig.cwd = ''; newSessionConfig.model = ''; newSessionConfig.reasoningEffort = ''; branchState = null; branchError = ''; }
      else if (target.id === 'tc-create-model') { newSessionConfig.model = target.value; newSessionConfig.reasoningEffort = ''; }
      else if (target.id === 'tc-create-effort') newSessionConfig.reasoningEffort = target.value;
      else return;
      renderSwitch();
    };
    container.onclick = async event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button,[data-new-session="branches"]');
      if (!button || !newSessionConfig) return;
      event.stopPropagation();
      const action = button.dataset.newSession || button.dataset.tc;
      if (action === 'create-directory') { newSessionConfig.cwd = project()?.commonDirectories?.[Number(button.dataset.id)] || ''; renderSwitch(); return; }
      if (action === 'create-clear-directory') { newSessionConfig.cwd = ''; renderSwitch(); return; }
      if (action === 'create-pick-directory') {
        const selected = project(); if (!selected) return; button.disabled = true;
        try {
          const response = await api('/api/task-center/directory-picker', { method: 'POST', body: JSON.stringify({ deviceId: selected.deviceId, projectId: selected.id }) }) as DirectoryPickerResult;
          if (response.status === 'completed') newSessionConfig.cwd = response.cwd || '';
          else for (let attempt = 0; attempt < 300; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const status = await api(`/api/task-center/directory-picker?requestId=${encodeURIComponent(response.requestId)}`) as DirectoryPickerResult;
            if (status.status === 'completed') { newSessionConfig.cwd = status.cwd || ''; break; }
            if (status.status === 'cancelled') throw new Error('已取消选择目录');
            if (status.status === 'failed') throw new Error(status.message || '无法选择目录');
            if (attempt === 299) throw new Error('等待目录选择超时');
          }
        } catch (error: unknown) { newSessionStatus = errorMessage(error); }
        renderSwitch(); return;
      }
      if (action === 'branches') {
        if (branchLoading || branchState) return; branchLoading = true; renderSwitch();
        try { branchState = await api('/api/task-center/git', { method: 'POST', body: JSON.stringify({ action: 'list', projectId: project()?.id, deviceId: project()?.deviceId, cwd: newSessionConfig.cwd }) }) as BranchState; }
        catch (error: unknown) { branchError = errorMessage(error); }
        finally { branchLoading = false; renderSwitch(); container.querySelector<HTMLDetailsElement>('#history-branch-menu')!.open = true; }
        return;
      }
      if (action === 'switch-branch' || action === 'new-branch') {
        const branch = action === 'new-branch' ? container.querySelector<HTMLInputElement>('[data-new-session="new-branch-name"]')?.value.trim() : button.dataset.id;
        if (!branch) { newSessionStatus = '请输入分支名称'; renderSwitch(); return; }
        try { branchState = await api('/api/task-center/git', { method: 'POST', body: JSON.stringify({ action: action === 'new-branch' ? 'create' : 'switch', branch, projectId: project()?.id, deviceId: project()?.deviceId, cwd: newSessionConfig.cwd }) }) as BranchState; branchError = ''; }
        catch (error: unknown) { branchError = errorMessage(error); }
        renderSwitch(); return;
      }
      if (action !== 'create' || sending || !project()) return;
      const message = draft().text.trim(), selected = project()!;
      const signature = JSON.stringify([selected.deviceId, selected.id, newSessionConfig.cwd, newSessionConfig.model, newSessionConfig.reasoningEffort, message]);
      let attempt = newRequests.get(id);
      if (!attempt || attempt.signature !== signature) { attempt = { signature, requestId: requestId() }; newRequests.set(id, attempt); }
      sending = true; newSessionStatus = '正在带上上下文…'; renderSwitch(); update();
      try {
        const result = await api(`/api/sessions/${id}/continue-as-new`, { method: 'POST', body: JSON.stringify({ targetAgent: selected.agent || 'codex', projectId: selected.id, cwd: newSessionConfig.cwd.trim(), model: newSessionConfig.model, reasoningEffort: newSessionConfig.reasoningEffort, message, requestId: attempt.requestId }) }) as NewSessionResponse;
        drafts.get(id)!.text = ''; newRequests.delete(id);
        if (current === generation) await openSession(result.sessionId);
      } catch (error: unknown) { if (current === generation) newSessionStatus = `${errorMessage(error)}。再次点击可重试，输入已保留。`; }
      finally { if (current === generation) { sending = false; renderSwitch(); update(); } }
    };
  }
  function respond() {
    if (!job?.request) return;
    const executionId = job.id, request = job.request;
    const questions = request.method === 'item/tool/requestUserInput' ? request.params?.questions || null : null;
    const dialog = document.createElement('dialog'); dialog.className = 'tc-dialog';
    dialog.innerHTML = `<form><h2>回复 Agent 请求</h2>${questions ? questions.map((question, index) => `<label>${escape(question.question)}${question.options?.length ? `<p>${question.options.map(option => escape(option.label + '：' + (option.description || ''))).join('<br>')}</p>` : ''}<textarea name="answer${index}" maxlength="12000" required></textarea></label>`).join('') : `<pre>${escape(request.params?.command || JSON.stringify(request.params, null, 2))}</pre><label>本次操作<select name="decision"><option value="decline">拒绝</option><option value="accept">允许本次操作</option></select></label>`}<p role="alert"></p><button type="button" data-close>取消</button><button type="submit">发送回复</button></form>`;
    document.body.append(dialog); dialog.showModal();
    dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close()); dialog.onclose = () => dialog.remove();
    dialog.querySelector('form')!.onsubmit = async e => {
      e.preventDefault(); const form = new FormData(e.currentTarget as HTMLFormElement), button = dialog.querySelector('[type="submit"]') as HTMLButtonElement; button.disabled = true;
      try { await api('/api/task-center/execution-action', { method: 'POST', body: JSON.stringify({ executionId, action: 'respond', ...(questions ? { answers: Object.fromEntries(questions.map((question, index) => [question.id, form.get('answer' + index)])) } : { decision: form.get('decision') }) }) }); dialog.close(); }
      catch (error: unknown) { dialog.querySelector<HTMLElement>('[role="alert"]')!.textContent = errorMessage(error); button.disabled = false; }
    };
  }
  return { mount, unmount };
}
