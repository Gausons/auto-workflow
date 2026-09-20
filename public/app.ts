import { createHistoryComposer } from './historyComposer.js';
import { renderMessages } from './historyView.js';
import { createTaskCenterUI } from './taskCenter.js';

const select = (selector: string): any => document.querySelector(selector);
const escapeHtml = (value: any) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
const state: any = {
  user: null, permissions: [], config: {}, scheduler: {}, assignmentPeople: [], bugs: [], metrics: {},
  selectedBugId: null, view: currentView(), settingsSection: currentSettingsSection()
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
const historyComposer = createHistoryComposer({ api, canEdit: () => state.permissions.includes('work.execute'), refresh: (id: string) => loadAgentSession(id), syncHistory: syncAgentSession });
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
  historyComposer.unmount();
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  sessionStorage.removeItem('bugflow.sessionToken');
  location.reload();
}

function bindEvents() {
  window.addEventListener('hashchange', async () => {
    state.view = currentView();
    state.settingsSection = currentSettingsSection();
    render();
    await loadCurrentView();
  });
  select('.settings-nav').addEventListener('click', (event: any) => {
    const button = event.target.closest('[data-settings-target]');
    if (button) location.hash = `settings/${button.dataset.settingsTarget}`;
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
  if (state.view !== 'history') historyComposer.unmount();
  if (['tasks', 'new-task', 'inbox'].includes(state.view)) {
    await taskCenterUI.load();
    if (state.view === 'new-task') await taskCenterUI.openNew();
    else if (state.view === 'inbox') taskCenterUI.showInbox();
    else taskCenterUI.showTasks();
  }
  if (state.view === 'settings' && state.settingsSection === 'members') await loadMembers();
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
  if (state.view === 'settings' && state.settingsSection === 'members' && !can('members.manage')) state.settingsSection = 'account';
  if (state.view === 'settings' && state.settingsSection === 'config' && !can('config.manage')) state.settingsSection = 'assignment';
}

function render() {
  document.body.dataset.view = state.view;
  document.querySelectorAll('[data-page]').forEach((page: any) => { page.hidden = page.dataset.page !== state.view && !(['new-task', 'inbox'].includes(state.view) && page.dataset.page === 'tasks'); });
  document.querySelectorAll('[data-nav]').forEach((link: any) => link.classList.toggle('active', link.dataset.nav === state.view));
  const title: any = {
    inbox: ['未归属会话', '将历史会话关联到任务'],
    tasks: ['任务中心', '跨设备、跨 Agent 管理工作'],
    'new-task': ['新建任务', '描述目标并选择 Agent'],
    workbench: ['缺陷工作台', '同步缺陷并直接生成任务'],
    history: ['Agent 历史会话', '查看本地 Agent 工作记录'],
    settings: ['设置', '管理工作台和组织偏好']
  };
  const copy = title[state.view] || title.workbench;
  select('.topbar h1').textContent = copy[0];
  select('.topbar .eyebrow').textContent = copy[1];
  const workbench = state.view === 'workbench';
  els.syncNow.hidden = !workbench; els.assignAll.hidden = !workbench; els.createTaskFromBug.hidden = !workbench;
  renderSettings();
  renderMetrics(); renderBugList(); renderBugDetail(); renderConfig(); renderAssignmentPeople();
}

function renderSettings() {
  document.querySelectorAll('[data-settings-panel]').forEach((panel: any) => {
    panel.hidden = panel.dataset.settingsPanel !== state.settingsSection;
  });
  document.querySelectorAll('[data-settings-target]').forEach((button: any) => {
    const active = button.dataset.settingsTarget === state.settingsSection;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
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
  select('#historyFilters').addEventListener('submit', (event: any) => {
    event.preventDefault();
    historyState.agent = select('#historyAgent').value;
    historyState.query = select('#historyQuery').value.trim();
    historyState.workspace = select('#historyWorkspace').value;
    loadAgentHistory(0);
  });
  for (const selector of ['#historyAgent', '#historyWorkspace']) {
    select(selector).addEventListener('change', () => select('#historyFilters').requestSubmit());
  }
  select('#historyPrev').addEventListener('click', () => loadAgentHistory(Math.max(0, historyState.offset - 30)));
  select('#historyNext').addEventListener('click', () => loadAgentHistory(historyState.offset + 30));
  select('#historyList').addEventListener('click', (event: any) => {
    const button = event.target.closest('[data-session-id]');
    if (button) loadAgentSession(button.dataset.sessionId);
  });
  select('#historyDetail').addEventListener('click', (event: any) => {
    if (event.target.closest('[data-more-messages]') && historyState.detail) {
      loadAgentSession(historyState.selected, historyState.detail.messages.length);
    }
  });
}

const historyStatusLabel = (value: any) => ({ completed: '本轮结束', interrupted: '已中断', error: '发生错误', unknown: '运行状态未知' } as Record<string, string>)[value] || '运行状态未知';
const historyTime = (value: any) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '时间未知';

async function loadAgentHistory(offset = historyState.offset) {
  historyComposer.unmount();
  const request = ++historyState.listRequest;
  ++historyState.detailRequest;
  historyState.selected = null;
  historyState.detail = null;
  select('#historyDetail').innerHTML = '<div class="history-empty"><span>◎</span><h2>从一个会话开始</h2><p>选择历史会话，查看对话与工作过程</p></div>';
  select('#historyStatus').textContent = '正在读取历史会话，首次索引可能需要一些时间…';
  select('#historyList').replaceChildren();
  select('#historyPrev').disabled = true;
  select('#historyNext').disabled = true;
  try {
    const query = new URLSearchParams({ offset: String(offset), limit: '30', agent: historyState.agent, q: historyState.query, workspace: historyState.workspace });
    const data = await api(`/api/agent-sessions?${query}`);
    if (request !== historyState.listRequest) return;
    historyState.offset = data.offset;
    historyState.total = data.total;
    const sourceLabels: any = { available: '可读取', missing: '未找到历史目录', unconfigured: '未配置', error: '无法读取目录' };
    select('#historySources').textContent = `${data.scope === 'all' ? '全部本地工作区' : '仅组织工作目录'} · ${data.providers.map((provider: any) => `${provider.label}：${sourceLabels[provider.status]}${provider.skipped ? `（${provider.skipped} 项未能读取）` : ''}`).join(' · ')}`;
    select('#historyAgent').innerHTML = '<option value="">全部 Agent</option>' + data.providers.map((provider: any) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.label)}</option>`).join('');
    select('#historyAgent').value = historyState.agent;
    select('#historyWorkspace').innerHTML = '<option value="">全部工作区</option>' + data.workspaces.map((workspace: any) => `<option value="${escapeHtml(workspace.path)}">${escapeHtml(workspace.path === '__unknown__' ? '未知工作区' : workspace.path)} (${workspace.count})</option>`).join('');
    if (historyState.workspace && !data.workspaces.some((workspace: any) => workspace.path === historyState.workspace)) {
      const option = document.createElement('option');
      option.value = historyState.workspace;
      option.textContent = historyState.workspace + ' (0)';
      select('#historyWorkspace').append(option);
    }
    select('#historyWorkspace').value = historyState.workspace;
    select('#historyStatus').textContent = data.total ? `共 ${data.total} 个会话，按最近更新时间排序` : '没有匹配的会话，试试其他工作区或搜索词。';
    select('#historyList').innerHTML = data.sessions.map((session: any) => `<button class="history-card" type="button" data-session-id="${escapeHtml(session.id)}" aria-pressed="false">
      <strong>${escapeHtml(session.title)}</strong>
      <span class="history-meta">${escapeHtml(session.agentLabel)} · ${historyTime(session.updatedAt)}</span>
      <span>${escapeHtml(historyStatusLabel(session.status))} · ${session.messageCount} 条记录${session.archived ? ' · 已归档' : ''}${session.partial ? ' · 部分记录' : ''}</span>
      <span class="history-meta">${escapeHtml(session.cwd?.split('/').filter(Boolean).at(-1) || '未知工作区')}${session.branch ? ' · ' + escapeHtml(session.branch) : ''}</span></button>`).join('');
    select('#historyPage').textContent = data.total ? `${data.offset + 1}–${Math.min(data.offset + data.limit, data.total)} / ${data.total}` : '0 / 0';
    select('#historyPrev').disabled = data.offset === 0;
    select('#historyNext').disabled = data.offset + data.limit >= data.total;
  } catch (error: any) {
    if (request === historyState.listRequest) select('#historyStatus').textContent = `加载失败：${error.message}`;
  }
}

// Refresh only the transcript; keep the composer, focus and unsent draft mounted.
async function syncAgentSession(id: string) {
  const request = historyState.detailRequest;
  const messages: any[] = [];
  let data: any;
  do {
    data = await api(`/api/agent-sessions/${encodeURIComponent(id)}?offset=${messages.length}&limit=200`);
    messages.push(...data.messages);
  } while (messages.length < data.total && data.messages.length);
  if (request !== historyState.detailRequest || historyState.selected !== id) return null;
  historyState.detail = { ...data, messages };
  const transcript = select('#historyDetail [data-history-transcript]');
  const scroll = transcript?.closest('.history-chat-scroll');
  const follow = scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  if (transcript) {
    const html = renderMessages(messages);
    if (transcript.innerHTML !== html) transcript.innerHTML = html;
  }
  const footer = select('#historyDetail .history-chat-footer');
  if (footer) footer.innerHTML = `<span>已显示 ${messages.length} / ${data.total} 条记录</span>${messages.length < data.total ? '<button class="button secondary" type="button" data-more-messages>加载更多记录</button>' : ''}`;
  if (follow) scroll.scrollTop = scroll.scrollHeight;
  return messages;
}

async function loadAgentSession(id: string, offset = 0) {
  historyComposer.unmount();
  const request = ++historyState.detailRequest;
  historyState.selected = id;
  const panel = select('#historyDetail');
  if (!offset) {
    historyState.detail = null;
    panel.textContent = '正在读取会话…';
  } else {
    const button = panel.querySelector('[data-more-messages]');
    if (button) button.disabled = true;
  }
  document.querySelectorAll('[data-session-id]').forEach((button: any) => button.setAttribute('aria-pressed', String(button.dataset.sessionId === id)));
  try {
    const data = await api(`/api/agent-sessions/${encodeURIComponent(id)}?offset=${offset}&limit=100`);
    if (request !== historyState.detailRequest) return;
    historyState.detail = { ...data, messages: offset ? [...historyState.detail.messages, ...data.messages] : data.messages };
    const { session, messages, total } = historyState.detail;
    const duration = Math.max(0, Date.parse(session.updatedAt) - Date.parse(session.createdAt));
    const durationText = Number.isFinite(duration) ? `${Math.floor(duration / 60000)} 分钟 ${Math.floor(duration / 1000) % 60} 秒` : '未知';
    panel.innerHTML = `<header class="history-chat-header"><div><h2>${escapeHtml(session.title)}</h2><span>${escapeHtml(session.agentLabel)} · ${escapeHtml(session.cwd?.split('/').filter(Boolean).at(-1) || '未知工作区')}</span></div><span class="history-readonly">${session.agent === 'codex' && state.permissions.includes('work.execute') && !session.archived ? '可续聊' : '只读'}</span></header>
      <div class="history-chat-scroll"><div class="history-chat-content"><details class="history-session-info"><summary>会话跨度 ${durationText}<span>›</span></summary>
      <dl class="history-info"><dt>会话 ID</dt><dd>${escapeHtml(session.sessionId || session.id)}</dd><dt>工作目录</dt><dd>${escapeHtml(session.workspaces?.join('、') || session.cwd || '未知')}</dd><dt>模型 / 分支</dt><dd>${escapeHtml(session.model || '未知')} / ${escapeHtml(session.branch || '未知')}</dd><dt>记录状态</dt><dd>${escapeHtml(historyStatusLabel(session.status))}</dd><dt>创建 / 更新</dt><dd>${historyTime(session.createdAt)} / ${historyTime(session.updatedAt)}</dd></dl></details>
      ${session.partial ? '<p class="history-warning">部分记录损坏、尚未写完或超出读取上限，当前展示部分内容。</p>' : ''}
      <div class="history-messages" data-history-transcript>${renderMessages(messages)}</div>
      <div class="history-chat-footer"><span>已显示 ${messages.length} / ${total} 条记录</span>${messages.length < total ? '<button class="button secondary" type="button" data-more-messages>加载更多记录</button>' : ''}</div><div id="historyLiveOutput" class="history-messages" role="log" aria-live="polite"></div></div></div><section class="history-composer" id="historyComposer" aria-label="会话输入框"></section>`;
    historyComposer.mount(select('#historyComposer'), session, select('#historyLiveOutput'), messages);
  } catch (error: any) {
    if (request !== historyState.detailRequest) return;
    if (!offset) panel.textContent = `加载失败：${error.message}`;
    else {
      showToast(error.message);
      const button = panel.querySelector('[data-more-messages]');
      if (button) button.disabled = false;
    }
  }
}

function selectedBug() { return state.bugs.find((bug: any) => bug.id === state.selectedBugId) || null; }
function configurePolling() {
  const pending = state.bugs.some((bug: any) => ['pending', 'assigning'].includes(bug.assignmentRecommendation?.status));
  if (pending && !pollTimer) pollTimer = setInterval(() => loadBootstrap({ silent: true }).catch(() => {}), 3000);
  if (!pending && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
function currentView() {
  const view = location.hash.replace(/^#/, '') || 'tasks';
  if (view === 'settings' || view.startsWith('settings/') || ['assignment', 'config', 'members', 'account'].includes(view)) return 'settings';
  return ['tasks', 'new-task', 'workbench', 'history', 'inbox'].includes(view) ? view : 'tasks';
}
function currentSettingsSection() {
  const route = location.hash.replace(/^#/, '');
  const section = route.startsWith('settings/') ? route.slice('settings/'.length) : route;
  return ['assignment', 'config', 'members', 'account'].includes(section) ? section : 'assignment';
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
