import { taskContent } from './taskContent.js';
import { renderMessages, renderMarkdown } from './historyView.js';
import { taskTimeline, taskActivity } from './taskTimeline.js';
const labels: any = { waiting: '等待输入', error: '执行异常', running: '进行中', ready: '待接续', review: '待验收', completed: '已完成' };
const handoffLabels: any = { pending: '待接收', received: '已接收 · 待执行', started: '已开始执行', cancelled: '已取消', failed: '失败' };
const executionLabels: any = { blocked: '会话被占用 · 未发送', queued: '等待执行', launching: '正在创建会话', running: 'Agent 执行中', waiting: '等待你处理', completed: '本轮已完成', interrupted: '已停止', failed: '执行失败', unknown: '结果待核对' };
const modeLabels: any = { continue: '接着做', branch: '另开分支', reference: '引用信息' };
const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v: any) => String(v ?? '').replace(/[&<>"']/g, (c) => entities[c] || c);
const selectFrom = (root: ParentNode, selector: string): any => root.querySelector(selector);
const time = (v: any) => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未知';
export function createTaskCenterUI({ root, api, canEdit, toast }: any) {
  let data: any = { tasks: [], sessions: [], devices: [], handoffs: [], executions: [] }, selected: any = null, page = 'tasks', tab = 'progress', query = '', loaded = false, request = 0;
  let createFiles: File[] = [], branchState: any = null, branchKey = '', branchLoading = false, branchError = '';
  let draft = '', sourceSessionId: string | null = null, creating = false, createError = '';
  let createTargets: any[] | null = null, createTargetsError = '', createProjectIndex = 0, createModel = '', createReasoningEffort = '', createCwd = '';
  const sessionContent = new Map<string, any>();
  const expanded = new Set<string>();
  let pendingData: any = null;
  let taskQuery = '';
  const signature = (value: any) => JSON.stringify({ ...value, devices: value.devices.map(({ lastSeen, ...d }: any) => d) });
  const createdMessages: { text: string; taskId: string; executed: boolean }[] = [];
  const device = (id: any) => data.devices.find((d: any) => d.id === id);
  const position = (s: any) => `${device(s?.deviceId)?.name || '未知设备'} / ${s?.agentLabel || s?.agent || '未知 Agent'}`;
  const linked = (id: any) => data.tasks.find((t: any) => t.sessionIds.includes(id));
  const task: any = () => data.tasks.find((t: any) => t.id === selected);
  const button = (action: any, title: any, id = '', primary = false) => `<button type="button" class="button ${primary ? 'primary' : 'secondary'}" data-tc="${action}" data-id="${esc(id)}">${title}</button>`;
  const empty = (title: any, body: any) => `<div class="tc-empty"><h2>${title}</h2><p>${body}</p></div>`;
  async function load({ quiet = false }: any = {}) {
    if (selectFrom(root, 'dialog[open]')) return;
    if (quiet && page === 'inbox' && (selectFrom(root, 'details[open]') || (typeof document !== 'undefined' && document.activeElement?.id === 'tc-query'))) return;
    const id = ++request;
    if (!loaded) root.innerHTML = '<p role="status">正在汇总任务与会话…</p>';
    try { const result = await api('/api/task-center'); if (id !== request) return; if (quiet && loaded && signature(result) === signature(data)) return; if (quiet && loaded && page === 'tasks') { if (signature(result) !== signature(data)) { pendingData = result; const notice = selectFrom(root, '#tc-updates'); if (notice) notice.hidden = false; } return; } data = result; pendingData = null; loaded = true; if (!selected) { selected = data.tasks[0]?.id; const latest = task() && taskTimeline(task(), data).filter(i => i.kind === 'session').at(-1); if (latest) expanded.add(latest.id); } if (page !== 'new' || !selectFrom(root, '#tc-create-form')) render(); }
    catch (error: any) { if (id !== request) return; if (!quiet) { if (!loaded) root.innerHTML = `<p role="alert">${esc(error.message)}</p>${button('refresh', '重试')}`; else toast(error.message); } }
  }
  function sessionCard(s: any, assign = false) {
    const owner = linked(s.id);
    return `<article class="tc-session"><details class="tc-session-thread" data-session="${esc(s.id)}" ${expanded.has(s.id) ? 'open' : ''}><summary><strong>${esc(s.title)}</strong><span class="tc-meta">${esc(position(s))} · ${time(s.updatedAt)}${device(s.deviceId)?.online === false ? ' · 设备离线' : ''}${s.partial ? ' · 部分记录' : ''}</span></summary><div class="tc-thread-content" data-session-body="${esc(s.id)}">${sessionBody(s)}</div></details><div class="tc-actions">${assign && canEdit() ? button('link-dialog', owner ? '查看任务' : '关联任务', s.id) : ''}</div></article>`;
  }
  function handoffCard(h: any) {
    const target = device(h.deviceId);
    const ack = h.mode === 'reference' && h.status === 'received' ? '引用已接收' : handoffLabels[h.status];
    return `<article class="tc-handoff"><div class="tc-actions"><strong>${modeLabels[h.mode]} → ${esc(target?.name)} / ${esc(h.agent)}</strong><span class="tc-tag">${ack}</span></div><p class="tc-meta">${time(h.createdAt)} · 上下文 v${h.packet.contextVersion}${h.mode === 'branch' ? ' · 关联分支' : ''}</p><div class="tc-actions">${button('packet', '查看上下文', h.id)}${canEdit() && h.status === 'pending' ? button('received', '确认已接收', h.id) : ''}${canEdit() && h.status === 'received' && h.mode !== 'reference' ? button('started-dialog', '关联已开始的新会话', h.id) : ''}${canEdit() && ['pending', 'received'].includes(h.status) ? button('cancelled', '取消', h.id) : ''}${canEdit() && ['pending', 'received'].includes(h.status) ? button('failed-dialog', '报告失败', h.id) : ''}</div></article>`;
  }
  function executionCard(job: any) {
    const codexThreadId = job.threadId || (job.agent === 'codex' ? job.sessionId : null);
    const link = codexThreadId && job.deviceId === 'local' ? `<a class="button secondary" href="codex://threads/${encodeURIComponent(codexThreadId)}">在 Codex 中打开 ↗</a>` : '';
    return `<article class="tc-execution"><div class="tc-actions"><strong>${executionLabels[job.status]}</strong><span class="tc-meta">${time(job.createdAt)}</span></div>${['failed', 'blocked', 'unknown', 'waiting', 'interrupted'].includes(job.status) && job.message ? `<p>${esc(job.message)}</p>` : ''}<details class="tc-execution-details"><summary>执行详情</summary>${job.desktopMessage ? `<p class="tc-meta">${esc(job.desktopMessage)}</p>` : ''}${job.controlError ? `<p role="alert">${esc(job.controlError)}</p>` : ''}${job.releaseStatus ? `<p class="tc-meta">${({ releasing: '正在释放网页连接…', released: '网页连接已释放', failed: '会话释放失败，请检查服务进程' } as any)[job.releaseStatus] || ''}</p>` : ''}${job.deviceId !== 'local' && (job.sessionId || job.threadId) ? `<p class="tc-meta">目标设备的 Agent 会话：${esc(job.sessionId || job.threadId)}</p>` : ''}<p class="tc-meta">${esc(job.agentLabel || job.agent || 'Agent')} · ${esc(String(job.protocol || 'legacy').toUpperCase())} · ${esc(job.model || '默认模型')} · ${esc(job.reasoningEffort || '默认思考强度')} · ${esc(job.cwd)} · 上下文 v${job.contextVersion}</p></details><div class="tc-actions">${link}${canEdit() && job.status === 'waiting' && job.request ? button('execution-respond', '处理 Agent 请求', job.id, true) : ''}${canEdit() && ['queued', 'running', 'waiting'].includes(job.status) ? button('execution-stop', job.status === 'queued' ? '取消等待' : '停止执行', job.id) : ''}${canEdit() && job.status === 'unknown' ? button('execution-reconcile', '核对执行结果', job.id) : ''}</div>${job.output ? `<section class="history-markdown tc-execution-result" aria-label="执行结果">${renderMarkdown(job.output)}</section>` : ''}</article>`;
  }
  function sessionBody(s: any) {
    const cached = sessionContent.get(s.id);
    if (s.missing) return '<p>原始记录暂不可用，任务关联仍保留。</p>';
    if (cached?.error) return `<p role="alert">${esc(cached.error)}</p>${button('read-session', '重试读取', s.id)}`;
    if (cached?.messages) return `<div class="history-messages">${renderMessages(cached.messages)}</div><p class="tc-meta">已显示 ${cached.messages.length} / ${cached.total} 条记录${cached.partial ? ' · 部分记录' : ''}</p>${cached.messages.length < cached.total ? button('more-session', '加载更多记录', s.id) : ''}`;
    return `${s.excerpt ? `<pre>${esc(s.excerpt)}</pre>` : '<p class="tc-meta">展开后读取原始会话</p>'}${button('read-session', '读取会话', s.id)}`;
  }
  async function readSession(id: string, more = false) {
    const s = data.sessions.find((s: any) => s.id === id); if (!s) return;
    const old = sessionContent.get(id); if (old?.loading) return;
    sessionContent.set(id, { ...old, loading: true });
    try {
      if (s.deviceId === 'local' && (!['codexExecution', 'agentExecution'].includes(s.source) || s.historyId)) {
        const result = await api(`/api/agent-sessions/${encodeURIComponent(s.historyId || s.id)}?limit=100&offset=${more ? old?.messages?.length || 0 : 0}`);
        sessionContent.set(id, { messages: more ? [...(old?.messages || []), ...result.messages] : result.messages, total: result.total, partial: result.session?.partial });
      } else sessionContent.set(id, { messages: [{ role: 'assistant', text: s.excerpt || '尚未同步文本，请在目标设备查看。' }], total: 1, partial: true });
    } catch (error: any) { sessionContent.set(id, { error: error.message }); }
    const panel = selectFrom(root, `[data-session-body="${id}"]`); if (panel) panel.innerHTML = sessionBody(s);
  }
  function detail() {
    const t = task(); if (!t) return empty('从一件事开始', '创建任务，或把未归属会话关联到任务。');
    const items = taskTimeline(t, data), sessions = items.filter(i => i.kind === 'session');
    const jobs = (data.executions || []).filter((j: any) => j.taskId === t.id);
    const waiting = jobs.find((j: any) => j.status === 'waiting' && j.request);
    const active = jobs.some((j: any) => ['queued', 'launching', 'running', 'waiting', 'unknown'].includes(j.status));
    const timeline = items.map(item => {
      let content = '';
      if (item.kind === 'session') {
        const s = item.value, sessionStatus = s.status || '', status = executionLabels[sessionStatus] || ({ error: '执行异常', unknown: '状态未知' } as any)[sessionStatus] || '历史会话';
        const pendingJobs = item.jobs.filter((job: any) => job.status !== 'completed');
        content = `<details class="tc-session-thread" data-session="${esc(s.id)}" ${expanded.has(s.id) ? 'open' : ''}><summary><strong>${esc(s.title)}</strong><span class="tc-meta">${esc(position(s))} · ${status}${device(s.deviceId)?.online === false ? ' · 设备离线' : ''}${s.partial ? ' · 部分记录' : ''}</span></summary><div class="tc-thread-content"><p class="tc-meta">${esc(s.cwd || '未记录工作目录')}${s.sourceSessionId ? ' · 接续自 ' + esc(data.sessions.find((v: any) => v.id === s.sourceSessionId)?.title || s.sourceSessionId) : ''}</p><div data-session-body="${esc(s.id)}">${sessionBody(s)}</div>${pendingJobs.map(executionCard).join('')}${canEdit() ? `<div class="tc-actions"><a class="button secondary" href="#history/${esc(s.historyId || s.id)}">打开会话 / 切换 Agent</a>${s.source === 'conversation' ? '' : button('unlink-session', '解除关联', s.id)}${button('move-session', '移动到其他任务', s.id)}</div>` : ''}</div></details>`;
      } else content = item.kind === 'execution' ? executionCard(item.value) : handoffCard(item.value);
      return `<article class="tc-timeline-item"><time class="tc-meta">${time(item.at)}</time>${content}</article>`;
    }).join('');
    return `<header class="tc-detail-head"><div><span class="tc-tag">${labels[t.status] || t.status}</span><h2>${esc(t.title)}</h2><p class="tc-meta">${sessions.length} 段会话 · 最近活动 ${time(new Date(taskActivity(t, data)).toISOString())}</p></div><div class="tc-actions">${canEdit() ? button('edit', '编辑任务') + button('handoff-dialog', '转交 / 分支') : ''}</div></header><section class="tc-task-content history-markdown" aria-label="任务内容">${renderMarkdown(taskContent(t))}</section><div class="tc-actions"><h3>任务时间线</h3>${canEdit() ? button('associate', '关联历史会话') : ''}<button type="button" class="button secondary" id="tc-updates" data-tc="updates" hidden>有新进展 · 更新记录</button></div><div class="tc-timeline">${timeline}</div><footer class="tc-task-footer tc-actions">${canEdit() ? (!active ? button('complete', t.status === 'completed' ? '重新打开任务' : '标记任务完成') : '') + (waiting ? button('execution-respond', '处理待办', waiting.id, true) : !active && t.status !== 'completed' ? button('execute-dialog', '继续任务', '', true) : '') : '<span class="tc-meta">只读</span>'}</footer>`;
  }
  function taskList() {
    const needle = taskQuery.trim().toLowerCase();
    return data.tasks.filter((t: any) => !needle || [t.title, taskContent(t), ...data.sessions.filter((s: any) => t.sessionIds.includes(s.id)).flatMap((s: any) => [s.title, s.cwd, s.agent])].join(' ').toLowerCase().includes(needle))
      .sort((a: any, b: any) => Number(b.status === 'waiting') - Number(a.status === 'waiting') || taskActivity(b, data) - taskActivity(a, data))
      .map((t: any) => `<button type="button" class="tc-task" data-tc="select" data-id="${esc(t.id)}" aria-pressed="${selected === t.id}"><strong>${esc(t.title)}</strong><span>${labels[t.status] || esc(t.status)}</span><small>${time(new Date(taskActivity(t, data)).toISOString())} · ${t.sessionIds.length} 段会话</small></button>`).join('') || '<p class="tc-meta">暂无匹配任务</p>';
  }
  function render() {
    const unassigned = data.sessions.filter((s: any) => !linked(s.id));
    const needle = query.toLowerCase();
    root.innerHTML = `<header class="tc-heading"><div><p class="eyebrow">跨设备 · 跨 Agent</p><h1>${page === 'new' ? '新建任务' : '任务中心'}</h1></div><div class="tc-actions">${page === 'new' ? button('page', '返回任务中心', 'tasks') : button('refresh', '刷新')}</div></header>${page === 'new' ? createConversation() : `<nav class="tc-nav" aria-label="任务中心视图">${[['tasks', '全部任务', data.tasks.length], ['inbox', '未归属会话', unassigned.length], ['devices', '设备与 Agent', data.devices.length]].map(([id, title, count]) => `<button type="button" data-tc="page" data-id="${id}" aria-pressed="${page === id}">${title}<span>${count}</span></button>`).join('')}</nav>`}${page === 'new' ? '' : page === 'tasks' ? `<div class="tc-layout"><aside class="tc-list" aria-label="任务列表"><label class="tc-task-search">搜索任务与会话<input id="tc-task-query" value="${esc(taskQuery)}" placeholder="任务、会话标题、工作目录" maxlength="200"></label><div id="tc-task-results">${taskList()}</div></aside><div class="tc-detail">${detail()}</div></div>` : page === 'inbox' ? `<section class="tc-inbox"><div class="tc-actions"><h2>未归属会话</h2><label class="tc-search">搜索会话<input id="tc-query" value="${esc(query)}" placeholder="任务名、Agent 或工作目录" maxlength="200"></label></div><p class="tc-meta">自动汇总的历史记录需要手动关联任务；远端设备需运行同步连接器。</p><div id="tc-inbox-list">${unassigned.filter((s: any) => [s.title, s.agent, s.cwd, position(s)].join(' ').toLowerCase().includes(needle)).map((s: any) => sessionCard(s, true)).join('') || empty('暂无匹配会话', '可以调整搜索条件，或连接其他设备后刷新。')}</div></section>` : `<section class="tc-devices">${data.devices.map((d: any) => `<article><div class="tc-actions"><h2>${esc(d.name)}</h2><span class="tc-tag">${d.online ? '在线' : '离线'}</span></div><p>${d.agents.map(esc).join(' · ') || '未发现 Agent'}</p><p class="tc-meta">${d.transport === 'manual' ? '工作台所在设备 · 手动复制上下文接续' : '连接器 · 最近心跳 ' + time(d.lastSeen)}</p></article>`).join('')}<article><h2>连接另一台设备</h2><p>在设备上运行项目中的同步连接器，将会话目录和设备状态同步到同一工作台，并接收交接包。</p><code>pnpm device:sync</code><p class="tc-meta">连接参数见 README「多设备任务中心」。连接器不会启动 Agent 或执行交接指令。</p></article></section>`}`;
  }
  function dialog(title: any, body: any, submit = '') {
    const d = document.createElement('dialog'); d.className = 'tc-dialog';
    d.innerHTML = `<form><header class="tc-actions"><h2 id="tc-dialog-title">${title}</h2><button type="button" class="button secondary" data-close aria-label="关闭弹窗">关闭</button></header>${body}<p class="tc-form-error" role="alert"></p>${submit ? `<footer><button class="button primary" type="submit">${submit}</button></footer>` : ''}</form>`;
    d.setAttribute('aria-labelledby', 'tc-dialog-title'); root.append(d); d.showModal();
    selectFrom(d, '[data-close]').onclick = () => d.close(); d.onclose = () => d.remove(); return d;
  }
  function onSubmit(d: any, handler: any) {
    selectFrom(d, 'form').onsubmit = async (e: any) => { e.preventDefault(); const b = e.submitter; b.disabled = true;
      try { await handler(new FormData(e.currentTarget)); d.close(); await load(); }
      catch (error: any) { selectFrom(d, '.tc-form-error').textContent = error.message; }
      finally { if (b) b.disabled = false; }
    };
  }
  const mutate = (body: any) => api('/api/task-center', { method: 'POST', body: JSON.stringify(body) });
  const createProject = () => createTargets?.[createProjectIndex];
  function createModelOptions() {
    const project = createProject(), models = project?.models || [];
    return `<option value="">默认模型${project?.defaultModel ? `（${esc(project.defaultModel)}）` : ''}</option>${models.map((model: any) => `<option value="${esc(model.id)}" ${createModel === model.id ? 'selected' : ''}>${esc(model.name || model.id)}</option>`).join('')}`;
  }
  function createEffortOptions() {
    const project = createProject(), model = (project?.models || []).find((item: any) => item.id === (createModel || project?.defaultModel));
    const efforts = Array.isArray(model?.reasoningEfforts) ? model.reasoningEfforts : project?.reasoningEfforts || [];
    const fallback = model?.defaultReasoningEffort || project?.defaultReasoningEffort;
    return `<option value="">默认强度${fallback ? `（${esc(fallback)}）` : ''}</option>${efforts.map((effort: any) => `<option value="${esc(effort.id)}" ${createReasoningEffort === effort.id ? 'selected' : ''}>${esc(effort.name || effort.id)}</option>`).join('')}`;
  }
  const directoryName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd || '默认目录';
  const effortLabel = (value: string) => ({ none: '无', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极高' } as Record<string, string>)[value] || value;
  const createIcon = (kind: 'folder' | 'device') => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${kind === 'folder' ? '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M3 9h18"/>' : '<rect x="4" y="3" width="16" height="14" rx="2"/><path d="M2 20h20M9 17v3m6-3v3"/>'}</svg>`;
  const workspaceKey = () => JSON.stringify([createProject()?.id, createProject()?.deviceId, createCwd]);
  async function loadBranches() {
    const key = workspaceKey(); branchKey = key; branchLoading = true; branchError = ''; branchState = null;
    try { const result = await api('/api/task-center/git', { method: 'POST', body: JSON.stringify({ action: 'list', projectId: createProject()?.id, deviceId: createProject()?.deviceId, cwd: createCwd }) }); if (workspaceKey() === key) branchState = result; }
    catch (error: any) { if (workspaceKey() === key) branchError = error.message; }
    finally { branchLoading = false; if (workspaceKey() === key) { render(); const menu = selectFrom(root, '#tc-branch-menu'); if (menu) menu.open = true; } }
  }
  function branchMenu() {
    if (createProject()?.deviceId !== 'local') return '';
    const state = branchKey === workspaceKey() ? branchState : null;
    return `<details class="tc-config-menu tc-branch-menu" id="tc-branch-menu" name="create-config"><summary data-tc="branches" aria-label="Git 分支"><span aria-hidden="true">⑂</span><span>${esc(state?.current || 'Git 分支')}</span><span aria-hidden="true">⌄</span></summary><div class="tc-config-panel">
      ${branchLoading ? '<p role="status">正在读取分支…</p>' : branchError ? `<p role="alert">${esc(branchError)}</p>` : state?.repository ? `<input id="tc-branch-search" aria-label="搜索分支" placeholder="搜索分支"><p class="tc-create-hint">${state.current ? `当前：${esc(state.current)}` : '当前为分离 HEAD'} · 未提交：${state.changes} 项</p><div class="tc-branch-options">${state.branches.map((name: string) => `<button type="button" data-tc="switch-branch" data-id="${esc(name)}" aria-pressed="${name === state.current}">${esc(name)}${name === state.current ? ' ✓' : ''}</button>`).join('')}</div><label class="tc-create-setting">新分支<input id="tc-new-branch" aria-label="新分支名称" placeholder="输入分支名称" maxlength="200"></label><button type="button" class="button secondary" data-tc="new-branch">创建并切换</button>` : '<p class="tc-create-hint">当前目录不是 Git 仓库。</p>'}
    </div></details>`;
  }
  async function encodeFile(file: File) {
    return new Promise<{name: string; data: string}>((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
      reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(',')[1] || '' }); reader.readAsDataURL(file);
    });
  }
  function createConversation() {
    const project = createProject(), directories = project?.commonDirectories || [];
    const cwd = createCwd || project?.cwd || '';
    const model = (project?.models || []).find((item: any) => item.id === (createModel || project?.defaultModel));
    const modelLabel = model?.name || createModel || project?.defaultModel || '默认模型';
    const effort = createReasoningEffort || model?.defaultReasoningEffort || project?.defaultReasoningEffort || '';
    const disabled = creating ? 'disabled' : '';
    const targetOptions = (createTargets || []).map((item: any, index: number) => `<option value="${index}" ${index === createProjectIndex ? 'selected' : ''}>${esc(item.name)} · ${esc(item.deviceName)}${item.online ? '' : '（离线）'}</option>`).join('');
    return `<section class="tc-create" aria-label="新建任务会话">
      <div class="tc-create-log" role="log" aria-live="polite">${createdMessages.length ? createdMessages.map(m => `<p class="tc-create-message">${esc(m.text)}</p><div class="tc-create-reply">${m.executed ? '任务已创建并提交 Agent。' : '任务已创建。'}${button('open-created', '查看任务', m.taskId)}</div>`).join('') : empty('想让 Agent 完成什么？', '描述你的目标，让 Agent 帮你完成。')}</div>
      <form id="tc-create-form" class="tc-create-shell" aria-busy="${creating}">
        <div class="tc-create-context" aria-label="任务运行环境">${project ? `
          <details class="tc-config-menu tc-directory-menu" name="create-config">
            <summary title="${esc(cwd || '工作目录')}" aria-label="工作目录：${esc(cwd || '默认目录')}">${createIcon('folder')}<span id="tc-create-directory-name">${esc(directoryName(cwd))}</span><span class="tc-config-chevron" aria-hidden="true">⌄</span></summary>
            <div class="tc-config-panel">
              <label class="tc-create-setting" for="tc-create-cwd">工作目录</label>
              <input id="tc-create-cwd" aria-label="工作目录" value="${esc(createCwd)}" placeholder="${esc(project.cwd || '输入工作目录')}" maxlength="2000" ${disabled}>
              <div class="tc-actions"><button type="button" class="button secondary" data-tc="create-pick-directory" ${disabled}>选择目录</button><button type="button" class="button ghost" data-tc="create-clear-directory" ${disabled}>使用默认目录</button></div>
              ${directories.length ? `<p class="tc-create-hint">常用目录</p><div class="tc-directory-options">${directories.slice(0, 4).map((path: string, index: number) => `<button type="button" data-tc="create-directory" data-id="${index}" title="${esc(path)}" aria-label="${esc(path)}" aria-pressed="${path === cwd}" ${disabled}>${createIcon('folder')}<span>${esc(directoryName(path))}<small>${esc(path)}</small></span></button>`).join('')}</div>` : ''}
            </div>
          </details>
          <label class="tc-target-control" title="执行位置">${createIcon('device')}<select id="tc-create-project" aria-label="执行位置" ${disabled}>${targetOptions}</select></label>${branchMenu()}
        ` : `<p class="tc-create-hint" role="${createTargets === null ? 'status' : 'alert'}">${esc(createTargets === null ? '正在读取运行配置…' : createTargetsError || '未发现可用 Agent，仍可创建任务。')}</p>`}</div>
        <div class="tc-composer conversation-composer">
          ${sourceSessionId ? `<p class="tc-meta">将关联会话：${esc(data.sessions.find((s: any) => s.id === sourceSessionId)?.title)}</p>` : ''}
          <textarea id="tc-create-message" aria-label="任务描述" placeholder="描述任务、期望结果，或需要解决的问题…" rows="4" maxlength="64000" required ${disabled}>${esc(draft)}</textarea>
          <div class="tc-attachment-list">${createFiles.map((file, index) => `<span class="tc-attachment" title="${esc(file.name)}"><span>${esc(file.name)}</span><small>${Math.max(1, Math.round(file.size / 1024))} KB</small><button type="button" data-tc="remove-file" data-id="${index}" aria-label="移除 ${esc(file.name)}" ${disabled}>×</button></span>`).join('')}</div>
          <input type="file" id="tc-create-files" multiple hidden ${disabled}>
          <footer><div class="tc-create-tools"><button type="button" class="tc-attach-button" data-tc="attach-files" aria-label="附加文件" title="${project?.deviceId === 'local' ? '附加文件（最多 10 个，单个 5 MB）' : '附件暂仅支持工作台所在设备'}" ${creating || project?.deviceId !== 'local' ? 'disabled' : ''}>＋</button><span class="tc-create-shortcut">⌘ / Ctrl + Enter 发送</span></div><div class="tc-create-send">
            ${project ? `<details class="tc-config-menu tc-model-menu" name="create-config" id="tc-create-model-menu"><summary aria-label="模型与思考强度"><span>${esc(modelLabel)}</span><span class="tc-effort-label">${esc(effortLabel(effort) || '默认')}</span><span class="tc-config-chevron" aria-hidden="true">⌄</span></summary><div class="tc-config-panel"><label class="tc-create-setting">模型<select id="tc-create-model" ${disabled}>${createModelOptions()}</select></label><label class="tc-create-setting">思考强度<select id="tc-create-effort" ${disabled}>${createEffortOptions()}</select></label><p class="tc-create-hint">${esc(model?.description || '默认选项沿用所选 Agent 的配置。')}</p></div></details>` : ''}
            <button class="button primary" type="submit" aria-label="创建并发送任务" title="创建并发送任务" ${creating || !draft.trim() ? 'disabled' : ''}>${creating ? '…' : '↑'}</button>
          </div></footer>
          <p class="tc-form-error" role="alert" ${createError ? '' : 'hidden'}>${esc(createError)}</p>
        </div>
      </form>
    </section>`;
  }
  async function loadCreateTargets() {
    if (createTargets !== null) return;
    try {
      const result = await api('/api/task-center/codex');
      const targets = Array.isArray(result.projects) ? result.projects : [];
      createTargets = targets;
      createTargetsError = result.localError || '';
      createProjectIndex = Math.min(createProjectIndex, Math.max(0, targets.length - 1));
    } catch (error: any) { createTargets = []; createTargetsError = error.message; }
    if (page === 'new') render();
  }
  async function openCreate(sessionId: string | null = null) {
    if (!canEdit()) return;
    if (sessionId && !creating) {
      sourceSessionId = sessionId;
      draft = data.sessions.find((s: any) => s.id === sessionId)?.title || '';
      createError = '';
    }
    page = 'new'; render();
    await loadCreateTargets();
    selectFrom(root, '#tc-create-message')?.focus();
  }
  root.addEventListener('submit', async (e: any) => {
    if (e.target.id !== 'tc-create-form') return;
    e.preventDefault();
    if (creating || !canEdit() || !draft.trim()) return;
    const description = draft.trim();
    if (createFiles.length && createProject()?.deviceId !== 'local') { createError = '附件暂仅支持工作台所在设备，请移除附件或切回本地'; render(); return; }
    creating = true; createError = ''; render();
    try {
      const attachments = await Promise.all(createFiles.map(encodeFile));
      const result = await mutate({ action: 'create', content: description, sessionId: sourceSessionId });
      const project = createProject(); let executed = false;
      if (project) {
        try { await api('/api/task-center/execute', { method: 'POST', body: JSON.stringify({ taskId: result.taskId, revision: result.revision || 1, attachments, projectId: project.id, cwd: createCwd.trim(), model: createModel, reasoningEffort: createReasoningEffort, deviceId: project.deviceId }) }); executed = true; }
        catch (error: any) { createError = `任务已创建，但 Agent 启动失败：${error.message}`; }
      }
      createdMessages.push({ text: description, taskId: result.taskId, executed });
      selected = result.taskId; draft = ''; createFiles = []; sourceSessionId = null; createCwd = '';
      await load({ quiet: true });
      if (data.tasks.some((t: any) => t.id === result.taskId)) { page = 'tasks'; if (createError) toast(createError); }
    } catch (error: any) { createError = error.message; }
    finally {
      creating = false; render();
      if (page === 'new') {
        selectFrom(root, '#tc-create-message')?.focus();
        const log = selectFrom(root, '.tc-create-log'); log.scrollTop = log.scrollHeight;
      }
    }
  });
  root.addEventListener('keydown', (e: any) => {
    if (e.key === 'Enter' && ['tc-branch-search', 'tc-new-branch', 'tc-create-cwd'].includes(e.target.id)) { e.preventDefault(); return; }
    if (e.target.id === 'tc-create-message' && e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      e.preventDefault(); selectFrom(root, '#tc-create-form').requestSubmit();
    }
  });
  function editDialog(t: any) {
    if (!t) return;
    const d = dialog('编辑任务', `<label>任务内容 · Markdown<textarea class="tc-markdown-editor" name="content" rows="16" required maxlength="64000" placeholder="描述任务，支持 Markdown…">${esc(taskContent(t))}</textarea></label>`, '保存任务');
    onSubmit(d, async (f: any) => { const r = await mutate({ action: 'update', taskId: t.id, revision: t.revision, content: f.get('content'), status: t.status }); selected = r.taskId; page = 'tasks'; });
  }
  function handoffDialog() {
    const t = task(); const targets = data.devices.flatMap((d: any) => d.agents.map((agent: any) => ({ device: d, agent })));
    if (!targets.length) { toast('尚未发现可用 Agent，请先连接设备'); return; }
    const d = dialog('把任务交给…', `<div class="tc-two"><label>操作方式<select name="mode"><option value="continue">接着做 · 新会话接续</option><option value="branch">另开分支 · 保留原工作</option><option value="reference">引用信息 · 不转交工作</option></select></label><label>执行位置<select name="target">${targets.map((v: any, i: any) => `<option value="${i}">${esc(v.device.name)} / ${esc(v.agent)} · ${v.device.online ? '在线' : '离线'}</option>`).join('')}</select></label></div><p class="tc-meta" id="tc-effect"></p><label id="tc-target-session" hidden>引用到哪个会话<select name="targetSessionId"></select></label><h3>携带的信息</h3><p>完整任务 Markdown · 版本 v${t.contextVersion}</p><label class="tc-check"><input type="checkbox" name="includeSources" checked> 相关会话来源及已同步片段</label><details><summary>预览任务上下文</summary><div class="history-markdown">${renderMarkdown(taskContent(t))}</div></details><label>给下一位 Agent 的指令<textarea name="instruction" rows="4" required maxlength="12000">继续完成任务。</textarea></label><p class="tc-callout" id="tc-precheck"></p>`, '保存接续请求');
    const form: any = selectFrom(d, 'form');
    function update() {
      const v = targets[Number(form.elements.target.value)], mode = form.elements.mode.value;
      selectFrom(d, '#tc-effect').textContent = mode === 'continue' ? '原会话需先停止或完成当前步骤；目标开始后关联新会话。' : mode === 'branch' ? '创建关联分支任务，原任务继续保留。' : '只传递信息，保留原任务状态。';
      selectFrom(d, '#tc-target-session').hidden = mode !== 'reference';
      const sessions = data.sessions.filter((s: any) => s.deviceId === v.device.id && s.agent === v.agent);
      form.elements.targetSessionId.innerHTML = sessions.map((s: any) => `<option value="${s.id}">${esc(s.title)}</option>`).join('');
      form.elements.targetSessionId.required = mode === 'reference';
      selectFrom(d, '#tc-precheck').textContent = `${v.device.online ? v.device.transport === 'manual' ? '目标需手动复制交接包。' : '连接器将在下次同步时接收。' : '设备离线，请求将等待重新连接。'} 工作目录、文件版本和权限需在目标端核对；文件内容不会自动复制。`;
      form.querySelector('[type="submit"]').textContent = mode === 'reference' ? '准备引用' : mode === 'branch' ? '创建分支与交接包' : '保存接续请求';
    }
    form.elements.target.onchange = update; form.elements.mode.onchange = update; update();
    onSubmit(d, async (f: any) => { const v = targets[Number(f.get('target'))]; const r = await mutate({ action: 'handoff', taskId: t.id, revision: t.revision, deviceId: v.device.id, agent: v.agent, mode: f.get('mode'), targetSessionId: f.get('targetSessionId'), instruction: f.get('instruction'), includeSources: f.has('includeSources'), includeFiles: true }); selected = r.taskId; toast('已保存，等待目标接收'); });
  }
  function packetText(h: any) { const p = h.packet; return [`# ${p.title}`, `目标：${device(h.deviceId)?.name} / ${h.agent}`, `上下文版本：${p.contextVersion}`, h.targetSessionId ? `目标会话：${data.sessions.find((s: any) => s.id === h.targetSessionId)?.nativeId || h.targetSessionId}` : '', taskContent(p), `## 下一位 Agent 的指令\n${p.instruction}`, '## 来源', ...p.sources.map((s: any) => `${s.title} · ${s.agent} · ${s.nativeId}\n${s.cwd}\n${s.excerpt || '仅包含来源索引，可回到工作台查看原始记录。'}`), p.limitations].join('\n\n'); }
  root.addEventListener('input', (e: any) => {
    if (e.target.id === 'tc-branch-search') { const query = e.target.value.toLowerCase(); root.querySelectorAll('[data-tc="switch-branch"]').forEach((button: any) => { button.hidden = !button.dataset.id.toLowerCase().includes(query); }); return; }
    if (e.target.id === 'tc-task-query') { taskQuery = e.target.value; selectFrom(root, '#tc-task-results').innerHTML = taskList(); return; }
    if (e.target.id === 'tc-create-message') {
      draft = e.target.value;
      selectFrom(root, '#tc-create-form [type="submit"]').disabled = creating || !draft.trim();
      return;
    }
    if (e.target.id === 'tc-create-cwd') { createCwd = e.target.value; const name = selectFrom(root, '#tc-create-directory-name'); if (name) { name.textContent = directoryName(createCwd || createProject()?.cwd || ''); const summary = name.closest('summary'); if (summary) { summary.title = createCwd || createProject()?.cwd || '工作目录'; summary.setAttribute('aria-label', `工作目录：${summary.title}`); } } return; }
    if (e.target.id !== 'tc-query') return;
    query = e.target.value; const needle = query.toLowerCase();
    selectFrom(root, '#tc-inbox-list').innerHTML = data.sessions.filter((s: any) => !linked(s.id) && [s.title, s.agent, s.cwd, position(s)].join(' ').toLowerCase().includes(needle)).map((s: any) => sessionCard(s, true)).join('') || empty('暂无匹配会话', '试试其他搜索词。');
  });
  root.addEventListener('change', (e: any) => {
    if (e.target.id === 'tc-create-files') {
      const files = [...createFiles, ...Array.from(e.target.files || []) as File[]];
      if (files.length > 10 || files.some(f => f.size > 5 * 1024 * 1024) || files.reduce((sum, f) => sum + f.size, 0) > 10 * 1024 * 1024) createError = '最多 10 个附件，单个不超过 5 MB，总计不超过 10 MB';
      else { createFiles = files; createError = ''; }
      render(); return;
    }
    if (e.target.id === 'tc-create-project') {
      createProjectIndex = Number(e.target.value) || 0; createModel = ''; createReasoningEffort = ''; createCwd = ''; render();
    }
    if (e.target.id === 'tc-create-model' || e.target.id === 'tc-create-effort') {
      if (e.target.id === 'tc-create-model') { createModel = e.target.value; createReasoningEffort = ''; }
      else createReasoningEffort = e.target.value;
      render();
      const menu = selectFrom(root, '#tc-create-model-menu'); if (menu) menu.open = true;
      selectFrom(root, `#${e.target.id}`)?.focus();
    }
  });
  root.addEventListener('keydown', (e: any) => {
    if (e.key !== 'Escape') return;
    const menu = e.target.closest?.('.tc-config-menu');
    if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); }
  });
  root.addEventListener('click', async (e: any) => {
    if (!e.target.closest('.tc-config-menu')) root.querySelectorAll?.('.tc-config-menu[open]').forEach((menu: any) => { menu.open = false; });
    const b = e.target.closest('[data-tc]'); if (!b) return; const id = b.dataset.id, action = b.dataset.tc;
    try {
      if (['attach-files', 'remove-file', 'branches', 'switch-branch', 'new-branch'].includes(action) && creating) return;
      if (action === 'attach-files') { selectFrom(root, '#tc-create-files')?.click(); return; }
      if (action === 'remove-file') { createFiles.splice(Number(id), 1); render(); return; }
      if (action === 'branches') { if (!branchLoading && !selectFrom(root, '#tc-branch-menu')?.open) await loadBranches(); return; }
      if (action === 'switch-branch' || action === 'new-branch') {
        const branch = action === 'new-branch' ? selectFrom(root, '#tc-new-branch')?.value.trim() : id;
        if (!branch) { toast('请输入分支名称'); return; }
        b.disabled = true;
        const key = workspaceKey();
        try {
          const result = await api('/api/task-center/git', { method: 'POST', body: JSON.stringify({ action: action === 'new-branch' ? 'create' : 'switch', branch, projectId: createProject()?.id, deviceId: createProject()?.deviceId, cwd: createCwd }) });
          if (workspaceKey() === key) { branchState = result; branchKey = key; render(); }
        } finally { b.disabled = false; }
        return;
      }
      if (action === 'updates') { if (pendingData) { data = pendingData; pendingData = null; sessionContent.clear(); render(); for (const sid of expanded) await readSession(sid); } return; }
      if (action === 'read-session' || action === 'more-session') { b.disabled = true; await readSession(id, action === 'more-session'); return; }
      if (action === 'associate') { page = 'inbox'; render(); return; }
      if (action === 'complete') { const t = task(); await mutate({ action: 'update', taskId: t.id, revision: t.revision, content: taskContent(t), status: t.status === 'completed' ? 'ready' : 'completed' }); await load(); return; }
      if (action === 'unlink-session' || action === 'move-session') {
        const t = task();
        const d = dialog(action === 'unlink-session' ? '解除会话关联' : '移动会话', action === 'unlink-session' ? '<p>保留原始会话，解除后可在未归属会话中找到。</p>' : `<label>目标任务<select name="targetTaskId" required>${data.tasks.filter((v: any) => v.id !== t.id).map((v: any) => `<option value="${esc(v.id)}">${esc(v.title)}</option>`).join('')}</select></label>`, '确认');
        onSubmit(d, (f: any) => mutate({ action: action === 'unlink-session' ? 'unlink' : 'move', taskId: t.id, revision: t.revision, sessionId: id, targetTaskId: f.get('targetTaskId'), targetRevision: data.tasks.find((v: any) => v.id === f.get('targetTaskId'))?.revision })); return;
      }
      if (action === 'refresh') return await load();
      if (action === 'page') { page = id; render(); }
      if (action === 'create-directory') { createCwd = createProject()?.commonDirectories?.[Number(id)] || ''; render(); }
      if (action === 'create-clear-directory') { createCwd = ''; render(); }
      if (action === 'create-pick-directory') {
        const project = createProject(); if (!project) return;
        b.disabled = true;
        try {
          const response = await api('/api/task-center/directory-picker', { method: 'POST', body: JSON.stringify({ deviceId: project.deviceId, projectId: project.id }) });
          if (response.status === 'completed') createCwd = response.cwd;
          else {
            for (let attempt = 0; attempt < 300; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 1000));
              const status = await api(`/api/task-center/directory-picker?requestId=${encodeURIComponent(response.requestId)}`);
              if (status.status === 'completed') { createCwd = status.cwd; break; }
              if (status.status === 'cancelled') throw new Error('已取消选择目录');
              if (status.status === 'failed') throw new Error(status.message || '无法选择目录');
              if (attempt === 299) throw new Error('等待目录选择超时');
            }
          }
          render();
        } catch (error: any) { createError = error.message; render(); }
        finally { if (b) b.disabled = false; }
      }
      if (action === 'select') { selected = id; const sessionItems = taskTimeline(task(), data).filter(i => i.kind === 'session'); const latest = (taskQuery.trim() ? sessionItems.find(i => [i.value.title, i.value.cwd, i.value.agent].join(' ').toLowerCase().includes(taskQuery.trim().toLowerCase())) : null) || sessionItems.at(-1); if (latest) { expanded.add(latest.id); } render(); if (latest) { await readSession(latest.id); selectFrom(root, `[data-session="${latest.id}"]`)?.scrollIntoView?.({ block: 'nearest' }); } }
      if (action === 'tab') { tab = id; render(); }
      if (action === 'execute-dialog') {
        const t = task(); b.disabled = true;
        try {
          const result = await api('/api/task-center/codex');
          if (!result.projects.length) { toast(result.localError || '未发现可用的 Agent 执行目标，请检查 ACP Agent 或原执行器配置。'); return; }
          const d = dialog('继续任务', `<p>在所选设备新建会话，携带任务上下文和来源信息。</p><label>接续来源<select name="sourceSessionId"><option value="">仅任务上下文</option>${t.sessionIds.map((sid: string) => { const s = data.sessions.find((s: any) => s.id === sid); return s ? `<option value="${esc(sid)}" ${sid === t.sessionIds.at(-1) ? 'selected' : ''}>${esc(s.title)} · ${esc(position(s))}</option>` : ''; }).join('')}</select></label><label>补充指令<textarea name="instruction" rows="3" maxlength="12000" placeholder="本轮希望完成什么？"></textarea></label><label>执行目标<select name="project">${result.projects.map((p: any, i: any) => `<option value="${i}">${esc(p.deviceName)} / ${esc(p.name)} · ${esc(String(p.protocol || 'legacy').toUpperCase())} · ${p.online ? '在线' : '离线，等待连接'}</option>`).join('')}</select></label><label>IDE 工作目录<div class="tc-picker-row"><input name="cwd" readonly maxlength="2000" placeholder="未选择，使用目标默认目录"><button type="button" class="button secondary" id="tc-pick-directory">选择目录</button><button type="button" class="button ghost" id="tc-clear-directory">使用默认</button></div></label><section id="tc-common-directories"></section><div class="tc-two"><label>模型<select name="model"></select></label><label>思考强度<select name="reasoningEffort"></select></label></div><p class="tc-meta" id="tc-model-description"></p><h3>${esc(t.title)}</h3><p>${esc(taskContent(t))}</p><p class="tc-meta">目录选择器会在目标机器打开；模型和思考强度以目标 Agent 实际支持范围为准。</p>`, '立即执行');
          const form: any = selectFrom(d, 'form');
          const setDirectory = (cwd = '') => { form.elements.cwd.value = cwd; };
          const renderDirectories = () => {
            const p = result.projects[Number(form.elements.project.value)], directories = p.commonDirectories || [];
            const visible = directories.slice(0, 5), overflow = directories.slice(5);
            const choices = (items: any[], offset = 0) => `<div class="tc-actions">${items.map((cwd: any, i: any) => `<button type="button" class="button secondary" data-directory="${i + offset}">${esc(cwd)}</button>`).join('')}</div>`;
            selectFrom(d, '#tc-common-directories').innerHTML = directories.length ? `<p class="tc-meta">常用目录</p>${choices(visible)}${overflow.length ? `<details><summary>更多目录（${overflow.length}）</summary>${choices(overflow, 5)}</details>` : ''}` : '<p class="tc-meta">暂无常用目录，可直接输入。</p>';
            d.querySelectorAll('[data-directory]').forEach((button: any) => { button.onclick = () => setDirectory(directories[Number(button.dataset.directory)]); });
          };
          const renderModels = () => {
            const p = result.projects[Number(form.elements.project.value)], previousModel = form.elements.model.value;
            form.elements.model.innerHTML = `<option value="">使用 Agent 默认模型${p.defaultModel ? `（${esc(p.defaultModel)}）` : ''}</option>${(p.models || []).map((model: any) => `<option value="${esc(model.id)}">${esc(model.name || model.id)}</option>`).join('')}`;
            if ([...form.elements.model.options].some((option: any) => option.value === previousModel)) form.elements.model.value = previousModel;
            const model = (p.models || []).find((item: any) => item.id === form.elements.model.value), efforts = Array.isArray(model?.reasoningEfforts) ? model.reasoningEfforts : p.reasoningEfforts || [];
            form.elements.reasoningEffort.innerHTML = `<option value="">使用模型默认${model?.defaultReasoningEffort || p.defaultReasoningEffort ? `（${esc(model?.defaultReasoningEffort || p.defaultReasoningEffort)}）` : ''}</option>${efforts.map((effort: any) => `<option value="${esc(effort.id)}">${esc(effort.name || effort.id)}</option>`).join('')}`;
            selectFrom(d, '#tc-model-description').textContent = model?.description || '不选择时沿用目标 Agent 的默认配置。';
          };
          const pollDirectory = async (requestId: string) => {
            for (let attempt = 0; attempt < 300; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 1000));
              const status = await api(`/api/task-center/directory-picker?requestId=${encodeURIComponent(requestId)}`);
              if (status.status === 'completed') return status.cwd;
              if (status.status === 'cancelled') throw new Error('已在目标机器取消选择目录');
              if (status.status === 'failed') throw new Error(status.message || '目标机器无法选择目录');
            }
            throw new Error('等待目标机器选择目录超时');
          };
          selectFrom(d, '#tc-pick-directory').onclick = async (event: any) => {
            const button = event.currentTarget, p = result.projects[Number(form.elements.project.value)]; button.disabled = true;
            try {
              const response = await api('/api/task-center/directory-picker', { method: 'POST', body: JSON.stringify({ deviceId: p.deviceId, projectId: p.id }) });
              setDirectory(response.status === 'completed' ? response.cwd : await pollDirectory(response.requestId));
            } catch (error: any) { selectFrom(d, '.tc-form-error').textContent = error.message; }
            finally { button.disabled = false; }
          };
          selectFrom(d, '#tc-clear-directory').onclick = () => setDirectory('');
          form.elements.project.onchange = () => { setDirectory(''); renderDirectories(); renderModels(); };
          form.elements.model.onchange = renderModels;
          renderDirectories(); renderModels();
          onSubmit(d, async (f: any) => { const p = result.projects[Number(f.get('project'))]; await api('/api/task-center/execute', { method: 'POST', body: JSON.stringify({ taskId: t.id, revision: t.revision, projectId: p.id, cwd: String(f.get('cwd') || '').trim(), model: String(f.get('model') || ''), reasoningEffort: String(f.get('reasoningEffort') || ''), deviceId: p.deviceId, sourceSessionId: f.get('sourceSessionId'), instruction: f.get('instruction') }) }); tab = 'progress'; toast('已提交 Agent，执行状态将自动更新'); });
        } finally { if (b) b.disabled = false; }
      }
      if (action === 'execution-stop' || action === 'execution-reconcile') {
        b.disabled = true;
        await api('/api/task-center/execution-action', { method: 'POST', body: JSON.stringify({ executionId: id, action: action === 'execution-stop' ? 'stop' : 'reconcile' }) });
        await load();
      }
      if (action === 'execution-respond') {
        const job = data.executions.find((j: any) => j.id === id), request = job.request;
        const questions = request.method === 'item/tool/requestUserInput' ? request.params.questions : null;
        const body = questions ? questions.map((q: any, i: any) => `<label>${esc(q.question)}${q.options?.length ? `<p class="tc-meta">${q.options.map((o: any) => esc(o.label + '：' + o.description)).join('<br>')}</p>` : ''}<textarea name="answer${i}" required maxlength="12000"></textarea></label>`).join('') : `<p>${esc(request.params.reason || request.params.toolCall?.title || 'Agent 请求执行以下操作')}</p><pre>${esc(request.params.command || JSON.stringify(request.params.toolCall || request.params, null, 2))}</pre><label>本次操作<select name="decision"><option value="decline">拒绝</option><option value="accept">允许本次操作</option></select></label>`;
        const d = dialog('回复 Agent', body, '发送回复');
        onSubmit(d, (f: any) => api('/api/task-center/execution-action', { method: 'POST', body: JSON.stringify({ executionId: id, action: 'respond', decision: f.get('decision'), ...(questions ? { answers: Object.fromEntries(questions.map((q: any, i: any) => [q.id, f.get('answer' + i)])) } : {}) }) }));
      }
      if (action === 'new') await openCreate();
      if (action === 'open-created') { selected = id; page = 'tasks'; tab = 'progress'; render(); await load(); }
      if (action === 'edit') editDialog(task());
      if (action === 'handoff-dialog') handoffDialog();
      if (action === 'link-dialog') {
        const owner = linked(id); if (owner) { selected = owner.id; page = 'tasks'; render(); return; }
        const d = dialog('关联会话', `<label>选择已有任务<select name="taskId" required><option value="">请选择任务</option>${data.tasks.map((t: any) => `<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${esc(t.title)}</option>`).join('')}</select></label><button class="button secondary" type="button" id="tc-from-session">用此会话创建任务</button>`, '关联任务');
        selectFrom(d, '#tc-from-session').onclick = () => { d.close(); openCreate(id); };
        onSubmit(d, async (f: any) => { const t = data.tasks.find((t: any) => t.id === f.get('taskId')); await mutate({ action: 'link', taskId: t.id, revision: t.revision, sessionId: id }); selected = t.id; page = 'tasks'; });
      }
      if (action === 'session') {
        const s = data.sessions.find((s: any) => s.id === id);
        const d = dialog(esc(s.title), `<p class="tc-meta">${esc(position(s))} · ${esc(s.cwd)}</p><p class="tc-meta">${s.deviceId === 'local' ? '原始会话前 100 条记录' : '连接器同步的片段 · 非完整历史'}</p><div id="tc-messages">正在读取…</div>`);
        try { if (s.deviceId === 'local' && (!['codexExecution', 'agentExecution'].includes(s.source) || s.historyId)) { const result = await api(`/api/agent-sessions/${s.historyId || s.id}?limit=100`); selectFrom(d, '#tc-messages').innerHTML = result.messages.map((m: any) => `<article class="tc-message"><strong>${esc(m.role)}</strong><pre>${esc(m.text || '非文本消息，请在 Agent 历史会话中查看')}</pre></article>`).join('') || '<p>暂无文本消息</p>'; }
          else selectFrom(d, '#tc-messages').textContent = s.excerpt || '仅同步了会话索引，尚无文本片段。';
        } catch (error: any) { selectFrom(d, '#tc-messages').textContent = error.message; }
      }
      if (action === 'packet') {
        const h = data.handoffs.find((h: any) => h.id === id), content = packetText(h);
        const d = dialog('交接上下文', `<p class="tc-meta">${handoffLabels[h.status]} · 上下文 v${h.packet.contextVersion}</p><textarea readonly rows="16" aria-label="交接包内容">${esc(content)}</textarea><div class="tc-actions"><button type="button" class="button secondary" id="tc-copy">复制</button><button type="button" class="button secondary" id="tc-download">下载文本</button></div>`);
        selectFrom(d, '#tc-copy').onclick = async () => { try { await navigator.clipboard.writeText(content); toast('已复制'); } catch { selectFrom(d, 'textarea').select(); selectFrom(d, '.tc-form-error').textContent = '请复制已选中的文本。'; } };
        selectFrom(d, '#tc-download').onclick = () => { const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `handoff-${h.id}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
      }
      if (action === 'received' || action === 'cancelled') { b.disabled = true; await mutate({ action: 'ack', handoffId: id, status: action, note: action === 'received' ? '用户手动确认接收' : '' }); await load(); }
      if (action === 'failed-dialog') { const d = dialog('报告交接失败', '<label>失败原因<textarea name="note" required maxlength="2000"></textarea></label>', '记录失败'); onSubmit(d, (f: any) => mutate({ action: 'ack', handoffId: id, status: 'failed', note: f.get('note') })); }
      if (action === 'started-dialog') {
        const h = data.handoffs.find((h: any) => h.id === id), candidates = data.sessions.filter((s: any) => s.deviceId === h.deviceId && s.agent === h.agent && !linked(s.id));
        const d = dialog('关联已开始的新会话', `<p>请先在目标 Agent 开始工作并同步会话，再选择实际的接续会话。</p><label>目标会话<select name="sessionId" required><option value="">${candidates.length ? '请选择实际接续会话' : '暂无新会话，请同步后重试'}</option>${candidates.map((s: any) => `<option value="${s.id}">${esc(s.title)}</option>`).join('')}</select></label>`, '确认已开始');
        onSubmit(d, (f: any) => mutate({ action: 'ack', handoffId: id, status: 'started', sessionId: f.get('sessionId') }));
      }
    } catch (error: any) { toast(error.message); b.disabled = false; }
  });
  root.addEventListener('toggle', (e: any) => { const id = e.target.dataset?.session; if (!id) return; if (e.target.open) { expanded.add(id); if (!sessionContent.has(id)) void readSession(id); } else expanded.delete(id); }, true);
  setInterval(() => { if (!root.hidden && sessionStorage.getItem('bugflow.sessionToken')) load({ quiet: true }); }, 3000);
  return {
    load,
    openNew: () => openCreate(),
    showInbox: () => { page = 'inbox'; render(); },
    showTasks: () => { page = 'tasks'; render(); },
    selectTask: (taskId: string) => { selected = taskId; page = 'tasks'; tab = 'progress'; render(); }
  };
}
