import { renderMessages } from './historyView.js';
import { createTaskCenterUI } from './taskCenter.js';

const select = (selector: string): any => document.querySelector(selector);
const escapeHtml = (value: any) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
const state: any = {
  user: null, permissions: [], config: {}, scheduler: {}, assignmentPeople: [], bugs: [], metrics: {},
  selectedBugId: null, view: currentView()
};
const historyState: any = { offset: 0, total: 0, selected: null, listRequest: 0, detailRequest: 0, detail: null, agent: '', query: '', workspace: '' };
const els: any = {
  configForm: select('#configForm'), assigneeSelect: select('#assigneeSelect'),
  assignmentPeopleForm: select('#assignmentPeopleForm'), assignmentPeopleList: select('#assignmentPeopleList'),
  bugList: select('#bugList'), bugDetail: select('#bugDetail'), syncNow: select('#syncNow'),
  assignAll: select('#assignAll'), createTaskFromBug: select('#createTaskFromBug'),
  toggleScheduler: select('#toggleScheduler'), toast: select('#toast')
};
const taskCenterUI = createTaskCenterUI({
  root: select('#taskCenter'), api,
  canEdit: () => state.permissions.includes('work.execute'),
  toast: showToast
});
let pollTimer: any = null;
let configFormDirty = false;

init();

async function init() {
  bindEvents();
  sessionStorage.removeItem('bugflow.tenantToken');
  select('#loginForm').addEventListener('submit', login);
  select('#setupForm').addEventListener('submit', setup);
  select('#logoutTenant').addEventListener('click', logout);
  bindMemberEvents();
  if (!sessionStorage.getItem('bugflow.sessionToken')) return;
  try {
    await loadBootstrap();
    select('#loginScreen').hidden = true;
    select('#workspaceShell').hidden = false;
    await loadCurrentView();
  } catch (error: any) {
    select('#loginError').textContent = error.message;
  }
}

async function login(event: any) {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('button');
  button.disabled = true;
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    sessionStorage.setItem('bugflow.sessionToken', data.token);
    location.reload();
  } catch (error: any) { select('#loginError').textContent = error.message; }
  finally { button.disabled = false; }
}

async function setup(event: any) {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('button');
  const { token, ...input } = Object.fromEntries(new FormData(form));
  button.disabled = true;
  try {
    const data = await api('/api/auth/setup', { method: 'POST', headers: { Authorization: `Bearer ${String(token).trim()}` }, body: JSON.stringify(input) });
    select('#loginOrganization').value = data.tenant.id;
    select('#loginUsername').value = input.username;
    form.reset(); select('#setupDetails').open = false;
    select('#loginError').textContent = data.message;
  } catch (error: any) { select('#setupError').textContent = error.message; }
  finally { button.disabled = false; }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  sessionStorage.removeItem('bugflow.sessionToken');
  location.reload();
}

function bindEvents() {
  window.addEventListener('hashchange', async () => {
    state.view = currentView();
    render();
    await loadCurrentView();
  });
  els.syncNow.addEventListener('click', syncNow);
  els.assignAll.addEventListener('click', applyAllAssignments);
  els.createTaskFromBug.addEventListener('click', createTaskFromSelectedBug);
  els.toggleScheduler.addEventListener('click', toggleScheduler);
  els.configForm.addEventListener('submit', saveConfig);
  els.configForm.addEventListener('input', () => { configFormDirty = true; });
  els.assigneeSelect.addEventListener('change', () => {
    if (els.assigneeSelect.value) els.configForm.elements.assignee.value = els.assigneeSelect.value;
  });
  els.assignmentPeopleForm.addEventListener('submit', addAssignmentPerson);
  els.assignmentPeopleList.addEventListener('click', assignmentPeopleAction);
  els.bugList.addEventListener('click', bugAction);
  select('#attachmentPreviewClose').addEventListener('click', closeAttachmentPreview);
  select('#attachmentPreviewModal').addEventListener('click', (event: any) => {
    if (event.target === select('#attachmentPreviewModal')) closeAttachmentPreview();
  });
  bindHistoryEvents();
}

async function loadCurrentView() {
  if (['tasks', 'new-task'].includes(state.view)) {
    await taskCenterUI.load();
    if (state.view === 'new-task') await taskCenterUI.openNew();
    else taskCenterUI.showTasks();
  }
  if (state.view === 'members') await loadMembers();
  if (state.view === 'history') await loadAgentHistory();
}

async function loadBootstrap({ silent = false }: any = {}) {
  applyBootstrap(await api('/api/bootstrap'));
  if (!silent) showToast('工作台已加载');
}

function applyBootstrap(data: any) {
  Object.assign(state, {
    user: data.user || state.user, permissions: data.permissions || state.permissions,
    config: data.config || {}, scheduler: data.scheduler || {}, assignmentPeople: data.assignmentPeople || [],
    bugs: data.bugs || [], metrics: data.metrics || {}
  });
  if (!selectedBug() && state.bugs.length) state.selectedBugId = state.bugs[0].id;
  select('#tenantName').textContent = `${data.tenant?.name || ''} (${data.tenant?.id || ''})`;
  if (state.user) {
    select('#currentUser').textContent = `${state.user.displayName} · ${roleLabel(state.user.role)}`;
    select('#accountIdentity').textContent = `${state.user.username} · ${state.user.displayName}`;
  }
  renderPermissions();
  render();
  configurePolling();
}

function renderPermissions() {
  const can = (permission: string) => state.permissions.includes(permission);
  document.body.dataset.canExecute = String(can('work.execute'));
  document.body.dataset.canConfigure = String(can('config.manage'));
  document.body.dataset.canManagePeople = String(can('people.manage'));
  document.body.dataset.canManageMembers = String(can('members.manage'));
  if (state.view === 'members' && !can('members.manage')) state.view = 'workbench';
  if (state.view === 'config' && !can('config.manage')) state.view = 'workbench';
}

function render() {
  document.body.dataset.view = state.view;
  document.querySelectorAll('[data-page]').forEach((page: any) => { page.hidden = page.dataset.page !== state.view && !(state.view === 'new-task' && page.dataset.page === 'tasks'); });
  document.querySelectorAll('[data-nav]').forEach((link: any) => link.classList.toggle('active', link.dataset.nav === state.view));
  const title: any = {
    tasks: ['任务中心', '跨设备、跨 Agent 管理工作'],
    'new-task': ['新建任务', '描述目标并选择 Agent'],
    workbench: ['缺陷工作台', '同步缺陷并直接生成任务'],
    history: ['Agent 历史会话', '查看本地 Agent 工作记录'],
    assignment: ['分配规则', '维护缺陷经办人建议'],
    config: ['对接配置', '管理数据源和任务工作目录'],
    members: ['组织成员', '管理账号、角色和审计'],
    account: ['我的账号', '管理个人登录信息']
  };
  const copy = title[state.view] || title.workbench;
  select('.topbar h1').textContent = copy[0];
  select('.topbar .eyebrow').textContent = copy[1];
  const workbench = state.view === 'workbench';
  els.syncNow.hidden = !workbench; els.assignAll.hidden = !workbench; els.createTaskFromBug.hidden = !workbench;
  renderMetrics(); renderBugList(); renderBugDetail(); renderConfig(); renderAssignmentPeople();
}

function renderMetrics() {
  for (const [id, key] of [['metricTotal', 'total'], ['metricPending', 'pending'], ['metricProcessing', 'processing'], ['metricResolved', 'resolved']]) {
    const element = select('#' + id); if (element) element.textContent = String(state.metrics[key] || 0);
  }
  select('#syncState').textContent = state.scheduler.lastRunMessage || '尚未同步';
}

function renderBugList() {
  if (!state.bugs.length) {
    els.bugList.innerHTML = '<div class="empty">暂无缺陷，点击“立即拉取”。</div>';
    return;
  }
  els.bugList.innerHTML = state.bugs.map((bug: any) => `
    <button class="bug-item ${bug.id === state.selectedBugId ? 'active' : ''}" type="button" data-bug-id="${escapeHtml(bug.id)}">
      <strong>${escapeHtml(bug.code || bug.id)}</strong>
      <span>${escapeHtml(bug.title)}</span>
      <small>${escapeHtml(bug.status || '未知')} · ${escapeHtml(bug.priority || bug.severity || '未定级')}</small>
    </button>`).join('');
}

function renderBugDetail() {
  const bug = selectedBug();
  if (!bug) {
    select('#selectedState').textContent = '未选择';
    els.bugDetail.innerHTML = '<div class="empty">从左侧选择一个缺陷。</div>';
    return;
  }
  select('#selectedState').textContent = bug.code || bug.id;
  const recommendation = bug.assignmentRecommendation || {};
  const attachments = bug.attachmentsLoaded
    ? (bug.attachments || []).map((item: any, index: number) => `<button class="button ghost" type="button" data-attachment-preview="${index}">${escapeHtml(item.name || '附件')}</button>`).join('')
    : '<button class="button ghost" type="button" data-load-attachments>加载附件</button>';
  els.bugDetail.innerHTML = `
    <div class="detail-heading"><div><span class="tag">${escapeHtml(bug.status || '未知')}</span><h2>${escapeHtml(bug.title)}</h2><p>${escapeHtml(bug.code || bug.id)}</p></div>
      <button class="button primary" type="button" data-create-task>生成任务</button></div>
    <dl>
      <div><dt>优先级</dt><dd>${escapeHtml(bug.priority || bug.severity || '未填写')}</dd></div>
      <div><dt>经办人</dt><dd>${escapeHtml(bug.assignee || '未分配')}</dd></div>
      <div><dt>更新时间</dt><dd>${escapeHtml(bug.updatedAt || '未知')}</dd></div>
    </dl>
    <h3>问题描述</h3><p>${escapeHtml(bug.description || '未填写')}</p>
    ${bug.expected ? `<h3>预期结果</h3><p>${escapeHtml(bug.expected)}</p>` : ''}
    ${bug.actual ? `<h3>实际结果</h3><p>${escapeHtml(bug.actual)}</p>` : ''}
    <h3>附件</h3><div class="attachment-list">${attachments || '无附件'}</div>
    <h3>分配建议</h3>
    <p>${escapeHtml(recommendation.reason || recommendation.error || '尚未生成')}</p>
    <div class="form-actions">
      <button class="button secondary" type="button" data-assignment-recommend>刷新建议</button>
      ${recommendation.assigneeId ? `<button class="button secondary" type="button" data-assignment-apply>分配给 ${escapeHtml(recommendation.assigneeName || recommendation.assigneeId)}</button>` : ''}
    </div>`;
}

async function bugAction(event: any) {
  const item = event.target.closest('[data-bug-id]');
  if (item) { state.selectedBugId = item.dataset.bugId; render(); return; }
  if (event.target.closest('[data-create-task]')) return createTaskFromSelectedBug();
  if (event.target.closest('[data-load-attachments]')) return loadBugAttachments();
  if (event.target.closest('[data-assignment-recommend]')) return refreshAssignmentRecommendation();
  if (event.target.closest('[data-assignment-apply]')) return applyAssignmentRecommendation();
  const preview = event.target.closest('[data-attachment-preview]');
  if (preview) openAttachmentPreview(Number(preview.dataset.attachmentPreview));
}

async function createTaskFromSelectedBug() {
  const bug = selectedBug();
  if (!bug) return showToast('请先选择一个缺陷');
  els.createTaskFromBug.disabled = true;
  try {
    const result = await api(`/api/bugs/${encodeURIComponent(bug.id)}/task`, { method: 'POST', body: '{}' });
    location.hash = 'tasks';
    await taskCenterUI.load();
    taskCenterUI.selectTask(result.taskId);
    showToast(result.existing ? '该缺陷已有任务，已为你打开' : '已从缺陷生成任务');
  } catch (error: any) { showToast(error.message); }
  finally { els.createTaskFromBug.disabled = false; }
}

async function loadBugAttachments() {
  const bug = selectedBug(); if (!bug) return;
  try {
    const data = await api(`/api/bugs/${encodeURIComponent(bug.id)}/attachments`);
    bug.attachments = data.attachments; bug.attachmentsLoaded = true; renderBugDetail();
  } catch (error: any) { showToast(error.message); }
}

function openAttachmentPreview(index: number) {
  const item = selectedBug()?.attachments?.[index]; if (!item?.url) return;
  const modal = select('#attachmentPreviewModal'), image = select('#attachmentPreviewImage');
  select('#attachmentPreviewTitle').textContent = item.name || '图片预览';
  select('#attachmentPreviewDownload').href = item.url;
  image.src = item.url; image.alt = item.name || '附件';
  modal.hidden = false;
}
function closeAttachmentPreview() { select('#attachmentPreviewModal').hidden = true; select('#attachmentPreviewImage').removeAttribute('src'); }

async function syncNow() {
  els.syncNow.disabled = true;
  try { applyBootstrap(await api('/api/sync', { method: 'POST' })); showToast(state.scheduler.lastRunMessage); }
  catch (error: any) { showToast(error.message); }
  finally { els.syncNow.disabled = false; }
}

async function refreshAssignmentRecommendation() {
  const bug = selectedBug(); if (!bug) return;
  try {
    const data = await api(`/api/bugs/${encodeURIComponent(bug.id)}/assignment/recommend`, { method: 'POST', body: '{}' });
    Object.assign(bug, data.bug); renderBugDetail();
  } catch (error: any) { showToast(error.message); }
}
async function applyAssignmentRecommendation() {
  const bug = selectedBug(); if (!bug) return;
  try {
    const data = await api(`/api/bugs/${encodeURIComponent(bug.id)}/assignment/apply`, { method: 'POST', body: '{}' });
    Object.assign(bug, data.bug); renderBugDetail(); showToast('分配完成');
  } catch (error: any) { showToast(error.message); }
}
async function applyAllAssignments() {
  try { applyBootstrap(await api('/api/assignments/apply-all', { method: 'POST', body: '{}' })); showToast('批量分配完成'); }
  catch (error: any) { showToast(error.message); }
}

function renderConfig() {
  if (!state.config || configFormDirty) return;
  for (const field of els.configForm.elements) {
    if (!field.name || !Object.hasOwn(state.config, field.name)) continue;
    if (field.type === 'checkbox') field.checked = Boolean(state.config[field.name]);
    else field.value = state.config[field.name] ?? '';
  }
  select('#workspacePolicy').hidden = !state.config.workspaceManaged;
  select('#credentialState').textContent = state.config.issueSourceConfigured ? `${state.config.issueSourceLabel} 已配置` : `${state.config.issueSourceLabel || '数据源'} 未配置`;
  select('#sidebarCredentialText').textContent = state.config.issueSourceConfigured ? '数据源已连接' : '数据源未配置';
  select('#sidebarCredentialDot').classList.toggle('online', Boolean(state.config.issueSourceConfigured));
  els.toggleScheduler.textContent = state.scheduler.enabled ? '关闭定时' : '开启定时';
}
async function saveConfig(event: any) {
  event.preventDefault();
  const form = new FormData(els.configForm), payload: any = Object.fromEntries(form.entries());
  payload.intervalMinutes = Number(payload.intervalMinutes);
  payload.openaiTimeoutMs = Number(payload.openaiTimeoutMs);
  payload.selfOnly = form.get('selfOnly') === 'true';
  payload.enableAIAssignment = form.get('enableAIAssignment') === 'true';
  payload.enableAutoAssignment = form.get('enableAutoAssignment') === 'true';
  try { configFormDirty = false; applyBootstrap(await api('/api/config', { method: 'PUT', body: JSON.stringify(payload) })); showToast('配置已保存'); }
  catch (error: any) { showToast(error.message); }
}
async function toggleScheduler() {
  try { applyBootstrap(await api('/api/scheduler', { method: 'POST', body: JSON.stringify({ enabled: !state.scheduler.enabled }) })); }
  catch (error: any) { showToast(error.message); }
}

function renderAssignmentPeople() {
  select('#assignmentPeopleState').textContent = `${state.assignmentPeople.length} 人`;
  els.assignmentPeopleList.innerHTML = state.assignmentPeople.map((person: any) => `
    <div class="member-card" data-person-id="${escapeHtml(person.employeeId)}">
      <label>姓名<input name="personName" value="${escapeHtml(person.name)}"></label>
      <label>员工号<input name="personEmployeeId" value="${escapeHtml(person.employeeId)}"></label>
      <label>职责<textarea name="personResponsibility">${escapeHtml(person.responsibility)}</textarea></label>
      <button class="button secondary" type="button" data-save-person>保存</button>
      <button class="button ghost" type="button" data-delete-person>删除</button>
    </div>`).join('') || '<div class="empty">尚未配置人员。</div>';
}
async function addAssignmentPerson(event: any) {
  event.preventDefault();
  const person: any = Object.fromEntries(new FormData(event.currentTarget));
  await saveAssignmentPeople([...state.assignmentPeople.filter((item: any) => item.employeeId !== person.employeeId), person]);
  event.currentTarget.reset();
}
async function assignmentPeopleAction(event: any) {
  const card = event.target.closest('[data-person-id]'); if (!card) return;
  const id = card.dataset.personId;
  if (event.target.closest('[data-delete-person]')) return saveAssignmentPeople(state.assignmentPeople.filter((item: any) => item.employeeId !== id));
  if (event.target.closest('[data-save-person]')) {
    const person = { name: card.querySelector('[name=personName]').value.trim(), employeeId: card.querySelector('[name=personEmployeeId]').value.trim(), responsibility: card.querySelector('[name=personResponsibility]').value.trim() };
    return saveAssignmentPeople([...state.assignmentPeople.filter((item: any) => item.employeeId !== id && item.employeeId !== person.employeeId), person]);
  }
}
async function saveAssignmentPeople(people: any) {
  try { applyBootstrap(await api('/api/assignment/people', { method: 'PUT', body: JSON.stringify({ people }) })); showToast('分配规则已保存'); }
  catch (error: any) { showToast(error.message); }
}

function roleLabel(role: string) { return ({ owner: '组织所有者', admin: '管理员', operator: '操作员', viewer: '只读成员' } as any)[role] || role; }
function roleOptions(selected = 'viewer') {
  const roles = state.user?.role === 'owner' ? ['owner', 'admin', 'operator', 'viewer'] : ['operator', 'viewer'];
  return roles.map((role) => `<option value="${role}" ${role === selected ? 'selected' : ''}>${roleLabel(role)}</option>`).join('');
}
function bindMemberEvents() {
  select('#refreshMembers').addEventListener('click', loadMembers);
  select('#memberForm').addEventListener('submit', async (event: any) => {
    event.preventDefault();
    try { await api('/api/organization/members', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); event.currentTarget.reset(); await loadMembers(); }
    catch (error: any) { showToast(error.message); }
  });
  select('#memberList').addEventListener('submit', async (event: any) => {
    event.preventDefault(); const form = event.target.closest('[data-member-id]');
    const body: any = Object.fromEntries(new FormData(form)); body.enabled = body.enabled === 'true';
    try { await api(`/api/organization/members/${form.dataset.memberId}`, { method: 'PATCH', body: JSON.stringify(body) }); await loadMembers(); }
    catch (error: any) { showToast(error.message); }
  });
  select('#memberList').addEventListener('click', async (event: any) => {
    const button = event.target.closest('[data-reset-password]'); if (!button) return;
    const form = button.closest('[data-member-id]');
    try { await api(`/api/organization/members/${form.dataset.memberId}/password`, { method: 'PUT', body: JSON.stringify({ password: form.elements.newPassword.value }) }); form.elements.newPassword.value = ''; showToast('密码已重置'); }
    catch (error: any) { showToast(error.message); }
  });
  select('#passwordForm').addEventListener('submit', async (event: any) => {
    event.preventDefault();
    try { await api('/api/auth/password', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); await logout(); }
    catch (error: any) { select('#passwordStatus').textContent = error.message; }
  });
}
async function loadMembers() {
  if (!state.permissions.includes('members.manage')) return;
  const [data, audit] = await Promise.all([api('/api/organization/members'), api('/api/organization/audit')]);
  select('#newMemberRole').innerHTML = roleOptions();
  select('#memberStatus').textContent = `${data.members.length} 位成员`;
  select('#memberList').innerHTML = data.members.map((member: any) => `<form class="member-card" data-member-id="${escapeHtml(member.id)}">
    <strong>${escapeHtml(member.username)} · ${roleLabel(member.role)}</strong>
    <label>显示名称<input name="displayName" value="${escapeHtml(member.displayName)}"></label>
    <label>角色<select name="role">${roleOptions(member.role)}</select></label>
    <label>状态<select name="enabled"><option value="true" ${member.enabled ? 'selected' : ''}>启用</option><option value="false" ${member.enabled ? '' : 'selected'}>停用</option></select></label>
    <button class="button secondary">保存</button>
    <label>重置密码<input name="newPassword" type="password"></label><button class="button ghost" type="button" data-reset-password>重置密码</button>
  </form>`).join('');
  select('#auditList').innerHTML = audit.events.map((item: any) => `<div class="member-card"><strong>${escapeHtml(item.actorName)} · ${escapeHtml(item.action)}</strong><p>${escapeHtml(item.createdAt)} · ${escapeHtml(item.target)}</p></div>`).join('');
}

function bindHistoryEvents() {
  select('#historyFilters').addEventListener('submit', (event: any) => { event.preventDefault(); historyState.offset = 0; loadAgentHistory(); });
  select('#historyPrev').addEventListener('click', () => { historyState.offset = Math.max(0, historyState.offset - 30); loadAgentHistory(); });
  select('#historyNext').addEventListener('click', () => { historyState.offset += 30; loadAgentHistory(); });
  select('#historyList').addEventListener('click', (event: any) => { const button = event.target.closest('[data-session-id]'); if (button) loadAgentHistoryDetail(button.dataset.sessionId); });
}
async function loadAgentHistory() {
  const query = new URLSearchParams({ offset: String(historyState.offset), limit: '30', q: select('#historyQuery').value || '', agent: select('#historyAgent').value || '', workspace: select('#historyWorkspace').value || '' });
  try {
    const data = await api(`/api/agent-sessions?${query}`);
    historyState.total = data.total || 0;
    select('#historyStatus').textContent = `${historyState.total} 个会话`;
    select('#historyList').innerHTML = (data.sessions || []).map((item: any) => `<button class="history-item" data-session-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.agentLabel || item.agent)}</span><small>${escapeHtml(item.updatedAt || '')}</small></button>`).join('') || '<div class="empty">暂无会话。</div>';
    select('#historyPrev').disabled = historyState.offset === 0;
    select('#historyNext').disabled = historyState.offset + 30 >= historyState.total;
    select('#historyPage').textContent = `${Math.floor(historyState.offset / 30) + 1}`;
    if (!select('#historyAgent').dataset.loaded) {
      select('#historyAgent').innerHTML += (data.providers || []).map((item: any) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label || item.id)}</option>`).join('');
      select('#historyWorkspace').innerHTML += (data.workspaces || []).map((item: any) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
      select('#historyAgent').dataset.loaded = 'true';
    }
  } catch (error: any) { select('#historyStatus').textContent = error.message; }
}
async function loadAgentHistoryDetail(id: string) {
  try {
    const data = await api(`/api/agent-sessions/${encodeURIComponent(id)}?limit=100`);
    select('#historyDetail').innerHTML = `<div class="history-detail-heading"><h2>${escapeHtml(data.session?.title || data.title || '会话')}</h2></div><div class="history-messages">${renderMessages(data.messages || [])}</div>`;
  } catch (error: any) { showToast(error.message); }
}

function selectedBug() { return state.bugs.find((bug: any) => bug.id === state.selectedBugId) || null; }
function configurePolling() {
  const pending = state.bugs.some((bug: any) => ['pending', 'assigning'].includes(bug.assignmentRecommendation?.status));
  if (pending && !pollTimer) pollTimer = setInterval(() => loadBootstrap({ silent: true }).catch(() => {}), 3000);
  if (!pending && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
function currentView() {
  const view = location.hash.replace(/^#/, '') || 'tasks';
  return ['tasks', 'new-task', 'workbench', 'history', 'assignment', 'config', 'members', 'account'].includes(view) ? view : 'tasks';
}
function showToast(message: any) {
  els.toast.textContent = String(message || ''); els.toast.classList.add('show');
  setTimeout(() => els.toast.classList.remove('show'), 2400);
}
async function api(url: string, options: any = {}) {
  const token = sessionStorage.getItem('bugflow.sessionToken');
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) sessionStorage.removeItem('bugflow.sessionToken');
    throw Object.assign(new Error(data.message || `请求失败：${response.status}`), { status: response.status });
  }
  return data;
}
