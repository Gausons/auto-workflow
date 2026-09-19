import { escape, renderMessages } from './historyView.js';
const requestId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const busy = new Set(['queued', 'launching', 'running', 'waiting', 'unknown']);
const names: Record<string, string> = { blocked: '会话被占用 · 未发送', queued: '等待执行', launching: '恢复原会话中', running: '正在回复', waiting: '等待你处理', completed: '本轮完成', failed: '执行失败', interrupted: '已停止', unknown: '结果待核对' };

export function createHistoryComposer({ api, canEdit, refresh }: any) {
  const restoredConflicts = new Set<string>();
  const drafts = new Map<string, { text: string; requestId: string; sentText: string }>();
  let host: HTMLElement | null = null, session: any = null, generation = 0, timer: any, sending = false, polling = false, job: any = null, outputSignature = '';
  const draft = () => { if (!drafts.has(session.id)) drafts.set(session.id, { text: '', requestId: '', sentText: '' }); return drafts.get(session.id)!; };
  const select = (s: string): any => host?.querySelector(s);
  function update() {
    const submit = select('[type="submit"]'), input = select('textarea');
    if (submit) submit.disabled = sending || (busy.has(job?.status) || job?.releaseStatus === 'releasing') || !input?.value.trim();
    if (input) input.disabled = sending;
    const status = select('[data-status]');
    if (status) status.textContent = sending ? '正在发送…' : job ? `${names[job.status] || job.status} · ${job.message || ''}${job.releaseStatus === 'releasing' ? ' · 正在释放会话' : job.releaseStatus === 'released' ? ' · 会话已释放，可在客户端接续' : job.releaseStatus === 'failed' ? ' · 会话释放失败，请检查服务进程' : ''}` : '消息将追加到原会话，沿用其上下文与配置。';
    const actions = select('[data-actions]');
    if (actions) actions.innerHTML = job ? `${['queued', 'running', 'waiting'].includes(job.status) ? '<button type="button" data-control="stop">停止</button>' : ''}${job.status === 'waiting' && job.request ? '<button type="button" data-control="respond">处理请求</button>' : ''}${job.status === 'unknown' ? '<button type="button" data-control="reconcile">核对结果</button>' : ''}${!busy.has(job.status) ? '<button type="button" data-refresh>刷新原始记录</button>' : ''}${['failed', 'interrupted', 'blocked'].includes(job.status) ? '<button type="button" data-restore>重新编辑本轮消息</button><button type="button" data-copy>复制本轮消息</button>' : ''}` : '';
    const output = select('[data-output]');
    const signature = JSON.stringify([job?.id, job?.prompt, job?.output]);
    if (output && signature !== outputSignature) {
      const previous = output.querySelector('details');
      const open = previous ? previous.open : true;
      output.innerHTML = job ? `<details ${open ? 'open' : ''}><summary>本轮续聊${job.output ? ' · 查看回复' : ''}</summary>${renderMessages([{ role: 'user', text: job.prompt }, ...(job.output ? [{ role: 'assistant', text: job.output }] : [])])}</details>` : '';
      outputSignature = signature;
    }
  }
  async function poll() {
    if (!host || !session || polling) return;
    const current = generation, id = session.id; polling = true;
    try { const result = await api(`/api/agent-sessions/${id}/continue`); if (current !== generation) return; job = result.execution;
      if (job?.status === 'blocked' && !restoredConflicts.has(job.id)) {
        const state = draft(); if (!state.text.trim()) { state.text = job.prompt; state.requestId = ''; select('textarea').value = state.text; }
        restoredConflicts.add(job.id);
      }
      update(); }
    catch (error: any) { if (current === generation && select('[data-error]')) select('[data-error]').textContent = error.message; }
    finally { if (current === generation) { polling = false; timer = setTimeout(poll, 2500); } }
  }
  function unmount() { generation++; clearTimeout(timer); host = null; session = null; polling = false; sending = false; job = null; outputSignature = ''; }
  function mount(element: HTMLElement, value: any) {
    unmount(); host = element; session = value;
    if (!canEdit() || value.agent !== 'codex' || !value.sessionId || value.archived) {
      host.innerHTML = `<p class="history-meta">${!canEdit() ? '只读成员无法发送消息。' : value.archived ? '请先在 Codex 客户端取消归档，再继续此会话。' : '此 Agent 暂不支持网页原会话续聊，请在对应客户端继续。'}</p>`; return;
    }
    const state = draft();
    host.innerHTML = `<div class="history-compose-heading"><strong>继续此会话</strong><a href="codex://threads/${encodeURIComponent(value.sessionId)}">在 Codex 中打开 ↗</a></div><div data-output></div><form><label for="historyReply">发送消息</label><textarea id="historyReply" rows="3" maxlength="12000" placeholder="继续讨论，或描述下一步需要完成的工作…" required>${escape(state.text)}</textarea><div class="history-compose-footer"><span class="history-meta">⌘ / Ctrl + Enter 发送</span><button type="submit">发送</button></div></form><p class="history-meta" data-status role="status"></p><p data-error role="alert"></p><div data-actions></div>`;
    select('textarea').oninput = (e: any) => { state.text = e.target.value; if (state.text.trim() !== state.sentText) state.requestId = ''; update(); };
    select('textarea').onkeydown = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (!select('[type="submit"]').disabled) select('form').requestSubmit(); } };
    select('form').onsubmit = async (e: Event) => {
      e.preventDefault(); if (sending || (busy.has(job?.status) || job?.releaseStatus === 'releasing') || !state.text.trim()) return;
      const current = generation, id = session.id, message = state.text.trim();
      state.requestId ||= requestId(); state.sentText = message;
      sending = true; select('[data-error]').textContent = ''; update();
      try {
        await api(`/api/agent-sessions/${id}/continue`, { method: 'POST', body: JSON.stringify({ message, requestId: state.requestId }) });
        if (state.text.trim() === message) state.text = ''; state.requestId = '';
        if (current === generation) { select('textarea').value = state.text; job = { status: 'queued', prompt: message, message: '已提交到原会话' }; }
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
    update(); void poll();
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
