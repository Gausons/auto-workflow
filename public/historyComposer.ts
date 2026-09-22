import { escape, renderMessages } from './historyView.js';
import { pendingHistoryMessages } from './historyTimeline.js';
const requestId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const busy = new Set(['queued', 'launching', 'running', 'waiting', 'unknown']);
const names: Record<string, string> = { blocked: '会话被占用 · 未发送', queued: '等待执行', launching: '正在连接 Agent', running: '正在回复', waiting: '等待你处理', completed: '本轮完成', failed: '执行失败', interrupted: '已停止', unknown: '结果待核对' };

export function createHistoryComposer({ api, canEdit, refresh, syncHistory, openSession }: any) {
  let canSendNative = false;
  const newRequests = new Map<string, { signature: string; requestId: string }>();
  const restoredConflicts = new Set<string>();
  const drafts = new Map<string, { text: string; requestId: string; sentText: string }>();
  let liveOutput: HTMLElement | null = null;
  let historyMessages: any[] = [], executions: any[] = [];
  let submission = 0, synchronizedSignature = '';
  let host: HTMLElement | null = null, session: any = null, generation = 0, timer: any, sending = false, polling = false, job: any = null, outputSignature = '';
  const draft = () => { if (!drafts.has(session.id)) drafts.set(session.id, { text: '', requestId: '', sentText: '' }); return drafts.get(session.id)!; };
  const select = (s: string): any => host?.querySelector(s);
  function update() {
    const submit = select('[type="submit"]'), input = select('textarea');
    if (submit) submit.disabled = !canSendNative || sending || (busy.has(job?.status) || job?.releaseStatus === 'releasing') || !input?.value.trim();
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
    try { const result = await api(`/api/agent-sessions/${id}/continue`); if (current !== generation || revision !== submission || sending) return;
      const resultExecutions = result.executions || (result.execution ? [result.execution] : []);
      const signature = JSON.stringify(resultExecutions);
      const snapshot = syncHistory && signature !== synchronizedSignature ? await syncHistory(id) : null;
      if (current !== generation || revision !== submission || sending) return;
      if (snapshot) historyMessages = snapshot;
      job = result.execution; executions = resultExecutions;
      if (!executions.some(item => busy.has(item.status)) && !pendingHistoryMessages(historyMessages, executions).length) synchronizedSignature = signature;
      if (job?.status === 'blocked' && !restoredConflicts.has(job.id)) {
        const state = draft(); if (!state.text.trim()) { state.text = job.prompt; state.requestId = ''; select('textarea').value = state.text; }
        restoredConflicts.add(job.id);
      }
      update(); }
    catch (error: any) { if (current === generation && select('[data-error]')) select('[data-error]').textContent = error.message; }
    finally { if (current === generation) { polling = false; timer = setTimeout(poll, 2500); } }
  }
  function unmount() { generation++; clearTimeout(timer); host = null; liveOutput = null; session = null; polling = false; sending = false; job = null; historyMessages = []; executions = []; synchronizedSignature = ''; outputSignature = ''; }
  function mount(element: HTMLElement, value: any, output?: HTMLElement, messages: any[] = []) {
    unmount(); host = element; liveOutput = output || null; session = value; historyMessages = messages;
    canSendNative = Boolean(value.managed || (value.agent === 'codex' && (!value.deviceId || value.deviceId === 'local') && value.sessionId && !value.archived));
    if (!canEdit()) {
      host.innerHTML = `<p class="history-meta">${!canEdit() ? '只读成员无法发送消息。' : value.archived ? '请先在 Codex 客户端取消归档，再继续此会话。' : '此 Agent 暂不支持网页原会话续聊，请在对应客户端继续。'}</p>`; return;
    }
    const state = draft();
    const contextLink = value.agent === 'codex' && value.sessionId ? `<a class="conversation-context" href="codex://threads/${encodeURIComponent(value.sessionId)}">在 Codex 中打开 ↗</a>` : `<span class="conversation-context">${escape(value.agentLabel || value.agent)} · ${escape(value.model || '默认配置')}</span>`;
    host.innerHTML = `<form class="conversation-composer"><label class="history-sr-only" for="historyReply">发送消息</label><textarea id="historyReply" rows="3" maxlength="12000" placeholder="继续讨论，或描述下一步需要完成的工作…" required>${escape(state.text)}</textarea><div class="history-compose-footer">${contextLink}<span class="conversation-send"><span class="history-meta">⌘ / Ctrl + Enter</span><button type="submit" aria-label="发送消息" title="发送消息">↑</button></span></div></form><p class="history-meta" data-status role="status"></p><p data-error role="alert"></p><div data-actions></div>`;
    select('textarea').oninput = (e: any) => { state.text = e.target.value; if (state.text.trim() !== state.sentText) state.requestId = ''; update(); };
    select('textarea').onkeydown = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (!select('[type="submit"]').disabled) select('form').requestSubmit(); } };
    select('form').onsubmit = async (e: Event) => {
      e.preventDefault(); if (!canSendNative || sending || (busy.has(job?.status) || job?.releaseStatus === 'releasing') || !state.text.trim()) return;
      const current = generation, id = session.id, message = state.text.trim(), createdAt = new Date().toISOString();
      state.requestId ||= requestId(); state.sentText = message;
      submission++; sending = true; select('[data-error]').textContent = ''; update();
      try {
        const result = await api(`/api/agent-sessions/${id}/continue`, { method: 'POST', body: JSON.stringify({ message, requestId: state.requestId }) });
        if (state.text.trim() === message) state.text = ''; state.requestId = '';
        if (current === generation) { select('textarea').value = state.text; job = { id: result.executionId, turnId: value.managed ? result.executionId : undefined, createdAt, status: 'queued', prompt: message, message: value.managed ? '已提交到当前会话' : '已提交到原会话' }; executions = [...executions.filter(item => item.id !== job.id), job]; }
      } catch (error: any) { if (current === generation) select('[data-error]').textContent = `${error.message}。输入已保留；再次发送相同内容不会重复提交。`; }
      finally { if (current === generation) { sending = false; update(); } }
    };
    host.onclick = async (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest('button'); if (!target) return;
      if (target.hasAttribute('data-copy')) { try { await navigator.clipboard.writeText(job.prompt); } catch { select('[data-error]').textContent = '无法自动复制，请使用输入框中的文本。'; } return; }
      if (target.hasAttribute('data-refresh')) { refresh(session.id); return; }
      if (target.hasAttribute('data-restore')) { state.text = job.prompt; state.requestId = ''; select('textarea').value = state.text; update(); select('textarea').focus(); return; }
      const action = target.dataset.control; if (!action || !job?.id) return;
      if (action === 'respond') { respond(); return; }
      const current = generation; target.disabled = true;
      try { await api('/api/task-center/execution-action', { method: 'POST', body: JSON.stringify({ executionId: job.id, action }) }); }
      catch (error: any) { if (current === generation) select('[data-error]').textContent = error.message; }
      finally { target.disabled = false; }
    };
    mountSwitch();
    update(); if (canSendNative) void poll();
  }
  function mountSwitch() {
    if (!host || !openSession) return;
    const current = generation, id = session.id, container = document.createElement('div');
    container.className = 'conversation-switch';
    container.innerHTML = '<label>带上下文新开会话 <select aria-label="目标 Agent"><option>正在查找 Agent…</option></select></label><button type="button" disabled>新开会话 →</button><span role="status"></span>';
    host.prepend(container);
    const choice = container.querySelector('select')!, button = container.querySelector('button')!, status = container.querySelector('span')!;
    void api('/api/task-center/codex').then((result: any) => {
      if (current !== generation) return;
      const agents: string[] = [...new Set<string>(result.projects.filter((p: any) => p.deviceId === (session.deviceId || 'local')).map((p: any) => p.agent || 'codex'))];
      choice.innerHTML = agents.length ? agents.map(agent => `<option value="${escape(agent)}">${escape(agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex' : agent)}</option>`).join('') : '<option value="">没有可用 Agent</option>';
      choice.value = agents.find(agent => agent !== session.agent) || agents[0] || '';
      button.disabled = !agents.length;
      if (!agents.length) status.textContent = result.localError || '请先配置 Agent';
    }).catch((error: any) => { if (current === generation) status.textContent = error.message; });
    button.onclick = async event => {
      event.stopPropagation(); if (sending || !choice.value) return;
      const message = draft().text.trim(), targetAgent = choice.value;
      const signature = JSON.stringify([targetAgent, message]);
      let attempt = newRequests.get(id);
      if (!attempt || attempt.signature !== signature) { attempt = { signature, requestId: requestId() }; newRequests.set(id, attempt); }
      sending = true; button.disabled = true; status.textContent = '正在带上上下文…'; update();
      try {
        const result = await api(`/api/sessions/${id}/continue-as-new`, { method: 'POST', body: JSON.stringify({ targetAgent, message, requestId: attempt.requestId }) });
        drafts.get(id)!.text = ''; newRequests.delete(id);
        if (current === generation) await openSession(result.sessionId);
      } catch (error: any) { if (current === generation) status.textContent = `${error.message}。再次点击可重试，输入已保留。`; }
      finally { if (current === generation) { sending = false; button.disabled = false; update(); } }
    };
  }
  function respond() {
    const executionId = job.id, request = job.request;
    const questions = request.method === 'item/tool/requestUserInput' ? request.params.questions : null;
    const dialog = document.createElement('dialog'); dialog.className = 'tc-dialog';
    dialog.innerHTML = `<form><h2>回复 Agent 请求</h2>${questions ? questions.map((q: any, i: number) => `<label>${escape(q.question)}${q.options?.length ? `<p>${q.options.map((o: any) => escape(o.label + '：' + o.description)).join('<br>')}</p>` : ''}<textarea name="answer${i}" maxlength="12000" required></textarea></label>`).join('') : `<pre>${escape(request.params.command || JSON.stringify(request.params, null, 2))}</pre><label>本次操作<select name="decision"><option value="decline">拒绝</option><option value="accept">允许本次操作</option></select></label>`}<p role="alert"></p><button type="button" data-close>取消</button><button type="submit">发送回复</button></form>`;
    document.body.append(dialog); dialog.showModal();
    dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close()); dialog.onclose = () => dialog.remove();
    dialog.querySelector('form')!.onsubmit = async e => {
      e.preventDefault(); const form = new FormData(e.currentTarget as HTMLFormElement), button = dialog.querySelector('[type="submit"]') as HTMLButtonElement; button.disabled = true;
      try { await api('/api/task-center/execution-action', { method: 'POST', body: JSON.stringify({ executionId, action: 'respond', ...(questions ? { answers: Object.fromEntries(questions.map((q: any, i: number) => [q.id, form.get('answer' + i)])) } : { decision: form.get('decision') }) }) }); dialog.close(); }
      catch (error: any) { dialog.querySelector('[role="alert"]')!.textContent = error.message; button.disabled = false; }
    };
  }
  return { mount, unmount };
}
