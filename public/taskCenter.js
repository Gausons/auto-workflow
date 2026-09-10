const labels = { waiting: '等待输入', error: '执行异常', running: '进行中', ready: '待接续', completed: '已完成' };
const handoffLabels = { pending: '待接收', received: '已接收 · 待执行', started: '已开始执行', cancelled: '已取消', failed: '失败' };
const executionLabels = { queued: '等待执行', launching: '正在创建会话', running: 'Codex 执行中', waiting: '等待你处理', completed: '本轮已完成', interrupted: '已停止', failed: '执行失败', unknown: '结果待核对' };
const modeLabels = { continue: '接着做', branch: '另开分支', reference: '引用信息' };
const fields = { goal: '任务目标', constraints: '约束', decisions: '已确认结论', next: '下一步', files: '文件与版本' };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = v => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未知';
export function createTaskCenterUI({ root, api, canEdit, toast }) {
  let data = { tasks: [], sessions: [], devices: [], handoffs: [], executions: [] }, selected = null, page = 'tasks', tab = 'progress', query = '', loaded = false, request = 0;
  const device = id => data.devices.find(d => d.id === id);
  const position = s => `${device(s?.deviceId)?.name || '未知设备'} / ${s?.agentLabel || s?.agent || '未知 Agent'}`;
  const linked = id => data.tasks.find(t => t.sessionIds.includes(id));
  const task = () => data.tasks.find(t => t.id === selected);
  const button = (action, title, id = '', primary = false) => `<button type="button" class="button ${primary ? 'primary' : 'secondary'}" data-tc="${action}" data-id="${esc(id)}">${title}</button>`;
  const empty = (title, body) => `<div class="tc-empty"><h2>${title}</h2><p>${body}</p></div>`;
  async function load({ quiet = false } = {}) {
    if (root.querySelector('dialog[open]')) return;
    const id = ++request;
    if (!loaded) root.innerHTML = '<p role="status">正在汇总任务与会话…</p>';
    try { const result = await api('/api/task-center'); if (id !== request) return; data = result; loaded = true; selected ||= data.tasks[0]?.id; render(); }
    catch (error) { if (id !== request) return; if (!quiet) { if (!loaded) root.innerHTML = `<p role="alert">${esc(error.message)}</p>${button('refresh', '重试')}`; else toast(error.message); } }
  }
  function sessionCard(s, assign = false) {
    const owner = linked(s.id);
    const transferred = data.handoffs.some(h => h.mode === 'continue' && h.status === 'started' && h.sourceSessionId === s.id);
    return `<article class="tc-session"><div><strong>${esc(s.title)}</strong><p class="tc-meta">${esc(position(s))} · ${time(s.updatedAt)}${transferred ? ' · 已交接' : ''}</p><p class="tc-meta">${esc(s.cwd || '未记录工作目录')}${s.partial ? ' · 部分记录' : ''}</p></div><div class="tc-actions">${button('session', '查看记录', s.id)}${assign && canEdit() ? button('link-dialog', owner ? '查看任务' : '关联任务', s.id) : ''}</div></article>`;
  }
  function handoffCard(h) {
    const target = device(h.deviceId);
    const ack = h.mode === 'reference' && h.status === 'received' ? '引用已接收' : handoffLabels[h.status];
    return `<article class="tc-handoff"><div class="tc-actions"><strong>${modeLabels[h.mode]} → ${esc(target?.name)} / ${esc(h.agent)}</strong><span class="tc-tag">${ack}</span></div><p class="tc-meta">${time(h.createdAt)} · 上下文 v${h.packet.contextVersion}${h.mode === 'branch' ? ' · 关联分支' : ''}</p><div class="tc-actions">${button('packet', '查看上下文', h.id)}${canEdit() && h.status === 'pending' ? button('received', '确认已接收', h.id) : ''}${canEdit() && h.status === 'received' && h.mode !== 'reference' ? button('started-dialog', '关联已开始的新会话', h.id) : ''}${canEdit() && ['pending', 'received'].includes(h.status) ? button('cancelled', '取消', h.id) : ''}${canEdit() && ['pending', 'received'].includes(h.status) ? button('failed-dialog', '报告失败', h.id) : ''}</div></article>`;
  }
  function executionCard(job) {
    const link = job.threadId && job.deviceId === 'local' ? `<a class="button secondary" href="codex://threads/${encodeURIComponent(job.threadId)}">在 Codex 中打开 ↗</a>` : '';
    return `<article class="tc-execution"><div class="tc-actions"><strong>${executionLabels[job.status]}</strong><span class="tc-meta">${time(job.createdAt)}</span></div><p>${esc(job.message)}</p>${job.desktopMessage ? `<p class="tc-meta">${esc(job.desktopMessage)}</p>` : ''}${job.controlError ? `<p role="alert">${esc(job.controlError)}</p>` : ''}${job.deviceId !== 'local' && job.threadId ? `<p class="tc-meta">目标设备的 Codex 会话：${esc(job.threadId)}</p>` : ''}<p class="tc-meta">${esc(job.cwd)} · 上下文 v${job.contextVersion}</p><div class="tc-actions">${link}${canEdit() && job.status === 'waiting' && job.request ? button('execution-respond', '处理 Codex 请求', job.id, true) : ''}${canEdit() && ['running', 'waiting'].includes(job.status) ? button('execution-stop', '停止执行', job.id) : ''}${canEdit() && job.status === 'unknown' ? button('execution-reconcile', '核对执行结果', job.id) : ''}</div>${job.output ? `<details><summary>查看执行回复</summary><pre>${esc(job.output)}</pre></details>` : ''}</article>`;
  }
  function detail() {
    const t = task(); if (!t) return empty('从一件事开始', '创建任务，或把未归属会话关联到任务。');
    const sessions = t.sessionIds.map(id => data.sessions.find(s => s.id === id)).filter(Boolean);
    const executions = (data.executions || []).filter(j => j.taskId === t.id).slice().reverse();
    const handoffs = data.handoffs.filter(h => h.taskId === t.id || h.destinationTaskId === t.id).slice().reverse();
    return `<header class="tc-detail-head"><div><span class="tc-tag">${labels[t.status]}</span><h2>${esc(t.title)}</h2><p class="tc-meta">${sessions.length} 段会话${sessions.length ? ' · ' + esc(position(sessions.at(-1))) : ''} · 更新于 ${time(t.updatedAt)}${t.parentTaskId ? ' · 分支任务' : ''}</p></div><div class="tc-actions">${canEdit() ? button('edit', '编辑任务') + button('handoff-dialog', '转交 / 分支') + button('execute-dialog', '执行 · Codex', '', true) : '<span class="tc-meta">只读</span>'}</div></header><nav class="tc-tabs" aria-label="任务内容">${[['progress', '进展'], ['context', '任务上下文'], ['sessions', '会话记录']].map(([key, label]) => `<button type="button" data-tc="tab" data-id="${key}" aria-pressed="${tab === key}">${label}</button>`).join('')}</nav>${tab === 'progress' ? `<section class="tc-next"><span class="tc-meta">下一步</span><p>${esc(t.context.next || '尚未填写下一步，编辑任务补充。')}</p></section>${executions.map(executionCard).join('')}${handoffs.map(handoffCard).join('')}<div class="tc-timeline">${t.events.map(e => `<article><span class="tc-meta">${time(e.at)}</span><p>${esc(e.message)}</p></article>`).join('')}</div>` : tab === 'context' ? `<p class="tc-meta">上下文 v${t.contextVersion} · 人工维护，交接时保存快照</p>${Object.entries(fields).map(([key, label]) => `<section class="tc-context"><h3>${label}</h3><p>${esc(t.context[key] || '尚未填写')}</p></section>`).join('')}<h3>来源会话</h3>${sessions.map(s => sessionCard(s)).join('') || '<p class="tc-meta">暂无来源会话</p>'}` : sessions.map(s => sessionCard(s)).join('') || empty('暂无关联会话', '在未归属会话中选择记录并关联到此任务。')}`;
  }
  function render() {
    const unassigned = data.sessions.filter(s => !linked(s.id));
    const needle = query.toLowerCase();
    root.innerHTML = `<header class="tc-heading"><div><p class="eyebrow">跨设备 · 跨 Agent</p><h1>任务中心</h1></div><div class="tc-actions">${button('refresh', '刷新')}${canEdit() ? button('new', '新建任务', '', true) : ''}</div></header><nav class="tc-nav" aria-label="任务中心视图">${[['tasks', '全部任务', data.tasks.length], ['inbox', '未归属会话', unassigned.length], ['devices', '设备与 Agent', data.devices.length]].map(([id, title, count]) => `<button type="button" data-tc="page" data-id="${id}" aria-pressed="${page === id}">${title}<span>${count}</span></button>`).join('')}</nav>${page === 'tasks' ? `<div class="tc-layout"><aside class="tc-list" aria-label="任务列表">${Object.entries(labels).map(([status, title]) => { const tasks = data.tasks.filter(t => t.status === status); return tasks.length ? `<h3>${title} <span>${tasks.length}</span></h3>${tasks.map(t => `<button type="button" class="tc-task" data-tc="select" data-id="${t.id}" aria-pressed="${selected === t.id}"><strong>${esc(t.title)}</strong><span>${esc(t.context.next || t.events[0]?.message)}</span><small>${time(t.updatedAt)} · ${t.sessionIds.length} 段会话</small><small>${t.sessionIds.length ? esc(position(data.sessions.find(s => s.id === t.sessionIds.at(-1)))) : '尚未选择执行位置'}</small></button>`).join('')}` : ''; }).join('') || '<p class="tc-meta">暂无任务</p>'}</aside><div class="tc-detail">${detail()}</div></div>` : page === 'inbox' ? `<section class="tc-inbox"><div class="tc-actions"><h2>未归属会话</h2><label class="tc-search">搜索会话<input id="tc-query" value="${esc(query)}" placeholder="任务名、Agent 或工作目录" maxlength="200"></label></div><p class="tc-meta">自动汇总的历史记录需要手动关联任务；远端设备需运行同步连接器。</p><div id="tc-inbox-list">${unassigned.filter(s => [s.title, s.agent, s.cwd, position(s)].join(' ').toLowerCase().includes(needle)).map(s => sessionCard(s, true)).join('') || empty('暂无匹配会话', '可以调整搜索条件，或连接其他设备后刷新。')}</div></section>` : `<section class="tc-devices">${data.devices.map(d => `<article><div class="tc-actions"><h2>${esc(d.name)}</h2><span class="tc-tag">${d.online ? '在线' : '离线'}</span></div><p>${d.agents.map(esc).join(' · ') || '未发现 Agent'}</p><p class="tc-meta">${d.transport === 'manual' ? '工作台所在设备 · 手动复制上下文接续' : '连接器 · 最近心跳 ' + time(d.lastSeen)}</p></article>`).join('')}<article><h2>连接另一台设备</h2><p>在设备上运行项目中的同步连接器，将会话目录和设备状态同步到同一工作台，并接收交接包。</p><code>pnpm device:sync</code><p class="tc-meta">连接参数见 README「多设备任务中心」。连接器不会启动 Agent 或执行交接指令。</p></article></section>`}`;
  }
  function dialog(title, body, submit = '') {
    const d = document.createElement('dialog'); d.className = 'tc-dialog';
    d.innerHTML = `<form><header class="tc-actions"><h2 id="tc-dialog-title">${title}</h2><button type="button" class="button secondary" data-close aria-label="关闭弹窗">关闭</button></header>${body}<p class="tc-form-error" role="alert"></p>${submit ? `<footer><button class="button primary" type="submit">${submit}</button></footer>` : ''}</form>`;
    d.setAttribute('aria-labelledby', 'tc-dialog-title'); root.append(d); d.showModal();
    d.querySelector('[data-close]').onclick = () => d.close(); d.onclose = () => d.remove(); return d;
  }
  function onSubmit(d, handler) {
    d.querySelector('form').onsubmit = async e => { e.preventDefault(); const b = e.submitter; b.disabled = true;
      try { await handler(new FormData(e.currentTarget)); d.close(); await load(); }
      catch (error) { d.querySelector('.tc-form-error').textContent = error.message; }
      finally { b.disabled = false; }
    };
  }
  const mutate = body => api('/api/task-center', { method: 'POST', body: JSON.stringify(body) });
  function editDialog(t = null, sessionId = null) {
    const s = data.sessions.find(s => s.id === sessionId);
    const d = dialog(t ? '编辑任务' : '新建任务', `<label>任务名称<input name="title" value="${esc(t?.title || s?.title)}" required maxlength="120"></label>${t ? `<label>任务状态<select name="status">${Object.entries(labels).map(([v, l]) => `<option value="${v}" ${t.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}${Object.entries(fields).map(([k, label]) => `<label>${label}<textarea name="${k}" rows="${k === 'goal' || k === 'next' ? 3 : 2}" maxlength="12000">${esc(t?.context[k] || (k === 'goal' ? s?.title : ''))}</textarea></label>`).join('')}`, t ? '保存任务' : '创建任务');
    onSubmit(d, async f => { const r = await mutate({ action: t ? 'update' : 'create', taskId: t?.id, revision: t?.revision, title: f.get('title'), status: f.get('status'), context: Object.fromEntries(Object.keys(fields).map(k => [k, f.get(k)])), sessionId }); selected = r.taskId; page = 'tasks'; });
  }
  function handoffDialog() {
    const t = task(); const targets = data.devices.flatMap(d => d.agents.map(agent => ({ device: d, agent })));
    if (!targets.length) { toast('尚未发现可用 Agent，请先连接设备'); return; }
    const d = dialog('把任务交给…', `<div class="tc-two"><label>操作方式<select name="mode"><option value="continue">接着做 · 新会话接续</option><option value="branch">另开分支 · 保留原工作</option><option value="reference">引用信息 · 不转交工作</option></select></label><label>执行位置<select name="target">${targets.map((v, i) => `<option value="${i}">${esc(v.device.name)} / ${esc(v.agent)} · ${v.device.online ? '在线' : '离线'}</option>`).join('')}</select></label></div><p class="tc-meta" id="tc-effect"></p><label id="tc-target-session" hidden>引用到哪个会话<select name="targetSessionId"></select></label><h3>携带的信息</h3><p>目标、约束、结论和下一步 · 上下文 v${t.contextVersion}</p><label class="tc-check"><input type="checkbox" name="includeSources" checked> 相关会话来源及已同步片段</label><label class="tc-check"><input type="checkbox" name="includeFiles" checked> 文件与版本清单</label><details><summary>预览任务上下文</summary>${Object.entries(fields).map(([k, l]) => `<h3>${l}</h3><pre>${esc(t.context[k] || '未填写')}</pre>`).join('')}</details><label>给下一位 Agent 的指令<textarea name="instruction" rows="4" required maxlength="12000">${esc(t.context.next)}</textarea></label><p class="tc-callout" id="tc-precheck"></p>`, '保存接续请求');
    const form = d.querySelector('form');
    function update() {
      const v = targets[Number(form.elements.target.value)], mode = form.elements.mode.value;
      d.querySelector('#tc-effect').textContent = mode === 'continue' ? '原会话需先停止或完成当前步骤；目标开始后关联新会话。' : mode === 'branch' ? '创建关联分支任务，原任务继续保留。' : '只传递信息，保留原任务状态。';
      d.querySelector('#tc-target-session').hidden = mode !== 'reference';
      const sessions = data.sessions.filter(s => s.deviceId === v.device.id && s.agent === v.agent);
      form.elements.targetSessionId.innerHTML = sessions.map(s => `<option value="${s.id}">${esc(s.title)}</option>`).join('');
      form.elements.targetSessionId.required = mode === 'reference';
      d.querySelector('#tc-precheck').textContent = `${v.device.online ? v.device.transport === 'manual' ? '目标需手动复制交接包。' : '连接器将在下次同步时接收。' : '设备离线，请求将等待重新连接。'} 工作目录、文件版本和权限需在目标端核对；文件内容不会自动复制。`;
      form.querySelector('[type="submit"]').textContent = mode === 'reference' ? '准备引用' : mode === 'branch' ? '创建分支与交接包' : '保存接续请求';
    }
    form.elements.target.onchange = update; form.elements.mode.onchange = update; update();
    onSubmit(d, async f => { const v = targets[Number(f.get('target'))]; const r = await mutate({ action: 'handoff', taskId: t.id, revision: t.revision, deviceId: v.device.id, agent: v.agent, mode: f.get('mode'), targetSessionId: f.get('targetSessionId'), instruction: f.get('instruction'), includeSources: f.has('includeSources'), includeFiles: f.has('includeFiles') }); selected = r.taskId; toast('已保存，等待目标接收'); });
  }
  function packetText(h) { const p = h.packet; return [`# ${p.title}`, `目标：${device(h.deviceId)?.name} / ${h.agent}`, `上下文版本：${p.contextVersion}`, h.targetSessionId ? `目标会话：${data.sessions.find(s => s.id === h.targetSessionId)?.nativeId || h.targetSessionId}` : '', ...Object.entries(fields).map(([k, l]) => `## ${l}\n${p.context[k] || '未填写'}`), `## 下一位 Agent 的指令\n${p.instruction}`, '## 来源', ...p.sources.map(s => `${s.title} · ${s.agent} · ${s.nativeId}\n${s.cwd}\n${s.excerpt || '仅包含来源索引，可回到工作台查看原始记录。'}`), p.limitations].join('\n\n'); }
  root.addEventListener('input', e => {
    if (e.target.id !== 'tc-query') return;
    query = e.target.value; const needle = query.toLowerCase();
    root.querySelector('#tc-inbox-list').innerHTML = data.sessions.filter(s => !linked(s.id) && [s.title, s.agent, s.cwd, position(s)].join(' ').toLowerCase().includes(needle)).map(s => sessionCard(s, true)).join('') || empty('暂无匹配会话', '试试其他搜索词。');
  });
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-tc]'); if (!b) return; const id = b.dataset.id, action = b.dataset.tc;
    try {
      if (action === 'refresh') return await load();
      if (action === 'page') { page = id; render(); }
      if (action === 'select') { selected = id; render(); }
      if (action === 'tab') { tab = id; render(); }
      if (action === 'execute-dialog') {
        const t = task(); b.disabled = true;
        try {
          const result = await api('/api/task-center/codex');
          if (!result.projects.length) { toast(result.localError || '请先在 Codex 客户端添加当前工作目录作为项目，再刷新执行。'); return; }
          const d = dialog('交给 Codex 执行', `<p>将在以下项目创建可在 Codex 客户端打开的新会话，并立即执行任务。</p><label>Codex 项目<select name="project">${result.projects.map((p, i) => `<option value="${i}">${esc(p.deviceName)} / ${esc(p.name)} · ${p.online ? '在线' : '离线，等待连接'} · ${esc(p.cwd)}</option>`).join('')}</select></label><h3>${esc(t.title)}</h3><p>${esc(t.context.next || t.context.goal || t.title)}</p><p class="tc-meta">使用目标 Codex 的登录和配置。执行过程中若需要确认，会在此任务中提示。</p>`, '立即执行');
          onSubmit(d, async f => { const p = result.projects[Number(f.get('project'))]; await api('/api/task-center/execute', { method: 'POST', body: JSON.stringify({ taskId: t.id, revision: t.revision, projectId: p.id, cwd: p.cwd, deviceId: p.deviceId }) }); tab = 'progress'; toast('已提交 Codex，执行状态将自动更新'); });
        } finally { b.disabled = false; }
      }
      if (action === 'execution-stop' || action === 'execution-reconcile') {
        b.disabled = true;
        await api('/api/task-center/execution-action', { method: 'POST', body: JSON.stringify({ executionId: id, action: action === 'execution-stop' ? 'stop' : 'reconcile' }) });
        await load();
      }
      if (action === 'execution-respond') {
        const job = data.executions.find(j => j.id === id), request = job.request;
        const questions = request.method === 'item/tool/requestUserInput' ? request.params.questions : null;
        const body = questions ? questions.map((q, i) => `<label>${esc(q.question)}${q.options?.length ? `<p class="tc-meta">${q.options.map(o => esc(o.label + '：' + o.description)).join('<br>')}</p>` : ''}<textarea name="answer${i}" required maxlength="12000"></textarea></label>`).join('') : `<p>${esc(request.params.reason || 'Codex 请求执行以下操作')}</p><pre>${esc(request.params.command || JSON.stringify(request.params, null, 2))}</pre><label>本次操作<select name="decision"><option value="decline">拒绝</option><option value="accept">允许本次操作</option></select></label>`;
        const d = dialog('回复 Codex', body, '发送回复');
        onSubmit(d, f => api('/api/task-center/execution-action', { method: 'POST', body: JSON.stringify({ executionId: id, action: 'respond', decision: f.get('decision'), ...(questions ? { answers: Object.fromEntries(questions.map((q, i) => [q.id, f.get('answer' + i)])) } : {}) }) }));
      }
      if (action === 'new') editDialog();
      if (action === 'edit') editDialog(task());
      if (action === 'handoff-dialog') handoffDialog();
      if (action === 'link-dialog') {
        const owner = linked(id); if (owner) { selected = owner.id; page = 'tasks'; render(); return; }
        const d = dialog('关联会话', `<label>选择已有任务<select name="taskId" required><option value="">请选择任务</option>${data.tasks.map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join('')}</select></label><button class="button secondary" type="button" id="tc-from-session">用此会话创建任务</button>`, '关联任务');
        d.querySelector('#tc-from-session').onclick = () => { d.close(); editDialog(null, id); };
        onSubmit(d, async f => { const t = data.tasks.find(t => t.id === f.get('taskId')); await mutate({ action: 'link', taskId: t.id, revision: t.revision, sessionId: id }); selected = t.id; page = 'tasks'; });
      }
      if (action === 'session') {
        const s = data.sessions.find(s => s.id === id);
        const d = dialog(esc(s.title), `<p class="tc-meta">${esc(position(s))} · ${esc(s.cwd)}</p><p class="tc-meta">${s.deviceId === 'local' ? '原始会话前 100 条记录' : '连接器同步的片段 · 非完整历史'}</p><div id="tc-messages">正在读取…</div>`);
        try { if (s.deviceId === 'local' && (s.source !== 'codexExecution' || s.historyId)) { const result = await api(`/api/agent-sessions/${s.historyId || s.id}?limit=100`); d.querySelector('#tc-messages').innerHTML = result.messages.map(m => `<article class="tc-message"><strong>${esc(m.role)}</strong><pre>${esc(m.text || '非文本消息，请在 Agent 历史会话中查看')}</pre></article>`).join('') || '<p>暂无文本消息</p>'; }
          else d.querySelector('#tc-messages').textContent = s.excerpt || '仅同步了会话索引，尚无文本片段。';
        } catch (error) { d.querySelector('#tc-messages').textContent = error.message; }
      }
      if (action === 'packet') {
        const h = data.handoffs.find(h => h.id === id), content = packetText(h);
        const d = dialog('交接上下文', `<p class="tc-meta">${handoffLabels[h.status]} · 上下文 v${h.packet.contextVersion}</p><textarea readonly rows="16" aria-label="交接包内容">${esc(content)}</textarea><div class="tc-actions"><button type="button" class="button secondary" id="tc-copy">复制</button><button type="button" class="button secondary" id="tc-download">下载文本</button></div>`);
        d.querySelector('#tc-copy').onclick = async () => { try { await navigator.clipboard.writeText(content); toast('已复制'); } catch { d.querySelector('textarea').select(); d.querySelector('.tc-form-error').textContent = '请复制已选中的文本。'; } };
        d.querySelector('#tc-download').onclick = () => { const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `handoff-${h.id}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
      }
      if (action === 'received' || action === 'cancelled') { b.disabled = true; await mutate({ action: 'ack', handoffId: id, status: action, note: action === 'received' ? '用户手动确认接收' : '' }); await load(); }
      if (action === 'failed-dialog') { const d = dialog('报告交接失败', '<label>失败原因<textarea name="note" required maxlength="2000"></textarea></label>', '记录失败'); onSubmit(d, f => mutate({ action: 'ack', handoffId: id, status: 'failed', note: f.get('note') })); }
      if (action === 'started-dialog') {
        const h = data.handoffs.find(h => h.id === id), candidates = data.sessions.filter(s => s.deviceId === h.deviceId && s.agent === h.agent && !linked(s.id));
        const d = dialog('关联已开始的新会话', `<p>请先在目标 Agent 开始工作并同步会话，再选择实际的接续会话。</p><label>目标会话<select name="sessionId" required><option value="">${candidates.length ? '请选择实际接续会话' : '暂无新会话，请同步后重试'}</option>${candidates.map(s => `<option value="${s.id}">${esc(s.title)}</option>`).join('')}</select></label>`, '确认已开始');
        onSubmit(d, f => mutate({ action: 'ack', handoffId: id, status: 'started', sessionId: f.get('sessionId') }));
      }
    } catch (error) { toast(error.message); b.disabled = false; }
  });
  setInterval(() => { if (!root.hidden && sessionStorage.getItem('bugflow.sessionToken')) load({ quiet: true }); }, 3000);
  return { load };
}
