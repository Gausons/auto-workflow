import { createHistoryComposer } from './historyComposer.js';
import { renderMessages } from './historyView.js';
import { createTaskCenterUI } from './taskCenter.js';
import type { HistoryMessage, Session } from './taskTypes.js';

type View = 'tasks' | 'new-task' | 'workbench' | 'history' | 'inbox' | 'settings';
type SettingsSection = 'assignment' | 'config' | 'members' | 'account';
type UserRole = 'owner' | 'admin' | 'operator' | 'viewer';
interface User { username: string; displayName: string; role: UserRole }
interface AssignmentPerson { name: string; employeeId: string; responsibility: string }
interface Attachment { name?: string; url?: string }
interface AssignmentRecommendation { status?: string; reason?: string; error?: string; assigneeId?: string; assigneeName?: string }
interface Bug {
  id: string; aid?: string; code?: string; title: string; status?: string; priority?: string; severity?: string;
  assignee?: string; updatedAt?: string; description?: string; expected?: string; actual?: string;
  attachments?: Attachment[]; attachmentsLoaded?: boolean; assignmentRecommendation?: AssignmentRecommendation;
}
interface AppConfig { workspaceManaged?: boolean; issueSourceConfigured?: boolean; issueSourceLabel?: string; [key: string]: unknown }
interface SchedulerState { enabled?: boolean; lastRunMessage?: string }
interface Metrics { total?: number; pending?: number; processing?: number; resolved?: number; [key: string]: number | undefined }
interface BootstrapData {
  tenant?: { id: string; name: string }; user?: User; permissions?: string[]; config?: AppConfig;
  scheduler?: SchedulerState; assignmentPeople?: AssignmentPerson[]; bugs?: Bug[]; metrics?: Metrics;
}
interface AppState {
  user: User | null; permissions: string[]; config: AppConfig; scheduler: SchedulerState;
  assignmentPeople: AssignmentPerson[]; bugs: Bug[]; metrics: Metrics; selectedBugId: string | null;
  view: View; settingsSection: SettingsSection;
}
interface HistorySession extends Session { createdAt: string; messageCount: number }
interface HistoryDetail { session: HistorySession; messages: HistoryMessage[]; total: number; inherited?: { count: number; partial?: boolean } }
interface HistoryState {
  offset: number; total: number; selected: string | null; listRequest: number; detailRequest: number;
  detail: HistoryDetail | null; agent: string; query: string; workspace: string;
}
interface HistoryProvider { id: string; label: string; status: string; skipped?: number }
interface HistoryWorkspace { path: string; count: number }
interface HistoryListResponse {
  offset: number; limit: number; total: number; scope: string; providers: HistoryProvider[];
  workspaces: HistoryWorkspace[]; sessions: HistorySession[];
}
function select<T extends Element = HTMLElement>(selector: string): T {
  return document.querySelector<T>(selector) as T;
}
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const roleLabel = (role: string) => ({ owner: '组织所有者', admin: '管理员', operator: '操作员', viewer: '只读成员' } as Record<string, string>)[role] || role;
const state: AppState = {
  user: null, permissions: [], config: {}, scheduler: {}, assignmentPeople: [], bugs: [], metrics: {},
  selectedBugId: null, view: currentView(), settingsSection: currentSettingsSection()
};
const historyState: HistoryState = { offset: 0, total: 0, selected: null, listRequest: 0, detailRequest: 0, detail: null, agent: '', query: '', workspace: '' };
const els = {
  configForm: select<HTMLFormElement>('#configForm'), assigneeSelect: select<HTMLSelectElement>('#assigneeSelect'),
  assignmentPeopleForm: select<HTMLFormElement>('#assignmentPeopleForm'), assignmentPeopleList: select<HTMLElement>('#assignmentPeopleList'),
  bugList: select<HTMLElement>('#bugList'), bugDetail: select<HTMLElement>('#bugDetail'), syncNow: select<HTMLButtonElement>('#syncNow'),
  assignAll: select<HTMLButtonElement>('#assignAll'), createTaskFromBug: select<HTMLButtonElement>('#createTaskFromBug'),
  toggleScheduler: select<HTMLButtonElement>('#toggleScheduler'), toast: select<HTMLElement>('#toast')
};
const taskCenterUI = createTaskCenterUI({
  root: select('#taskCenter'), api,
  canEdit: () => state.permissions.includes('work.execute'),
  toast: showToast
});
const historyComposer = createHistoryComposer({ api, canEdit: () => state.permissions.includes('work.execute'), refresh: (id: string) => loadAgentSession(id), syncHistory: syncAgentSession, openSession: (id: string) => { location.hash = `history/${id}`; } });
let pollTimer: ReturnType<typeof setInterval> | null = null;
let configFormDirty = false;

init();

async function init() {
  bindEvents();
  sessionStorage.removeItem('bugflow.tenantToken');
  select('#logoutTenant').addEventListener('click', logout);
  if (!sessionStorage.getItem('bugflow.sessionToken')) return;
  try {
    await loadBootstrap();
    select('#loginScreen').hidden = true;
    select('#workspaceShell').hidden = false;
    await loadCurrentView();
  } catch (error: unknown) {
    select('#loginScreen').hidden = false;
    select('#workspaceShell').hidden = true;
    window.dispatchEvent(new CustomEvent('bugflow:auth-required', { detail: { message: errorMessage(error) } }));
  }
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
  select('.settings-nav').addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLElement>('[data-settings-target]');
    if (button) location.hash = `settings/${button.dataset.settingsTarget}`;
  });
  els.syncNow.addEventListener('click', syncNow);
  els.assignAll.addEventListener('click', applyAllAssignments);
  els.createTaskFromBug.addEventListener('click', createTaskFromSelectedBug);
  els.toggleScheduler.addEventListener('click', toggleScheduler);
  els.configForm.addEventListener('submit', saveConfig);
  els.configForm.addEventListener('input', () => { configFormDirty = true; });
  els.assigneeSelect.addEventListener('change', () => {
    const assignee = els.configForm.elements.namedItem('assignee') as HTMLInputElement | null;
    if (els.assigneeSelect.value && assignee) assignee.value = els.assigneeSelect.value;
  });
  els.assignmentPeopleForm.addEventListener('submit', addAssignmentPerson);
  els.assignmentPeopleList.addEventListener('click', assignmentPeopleAction);
  els.bugList.addEventListener('click', bugAction);
  select('#attachmentPreviewClose').addEventListener('click', closeAttachmentPreview);
  select('#attachmentPreviewModal').addEventListener('click', (event) => {
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
  if (state.view === 'history') {
    await loadAgentHistory();
    const id = /^#history\/([a-f0-9]{64})$/.exec(location.hash)?.[1];
    if (id) await loadAgentSession(id);
  }
}

async function loadBootstrap({ silent = false }: { silent?: boolean } = {}) {
  applyBootstrap(await api<BootstrapData>('/api/bootstrap'));
  if (!silent) showToast('工作台已加载');
}

function applyBootstrap(data: BootstrapData) {
  Object.assign(state, {
    user: data.user || state.user, permissions: data.permissions || state.permissions,
    config: data.config || {}, scheduler: data.scheduler || {}, assignmentPeople: data.assignmentPeople || [],
    bugs: data.bugs || [], metrics: data.metrics || {}
  });
  if (!selectedBug() && state.bugs.length) state.selectedBugId = state.bugs[0].id;
  select('#tenantName').textContent = `${data.tenant?.name || ''} (${data.tenant?.id || ''})`;
  if (state.user) {
    select('#currentUser').textContent = `${state.user.displayName} · ${roleLabel(state.user.role)}`;
  }
  window.dispatchEvent(new CustomEvent('bugflow:bootstrap', { detail: { user: state.user, permissions: state.permissions } }));
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
  document.querySelectorAll<HTMLElement>('[data-page]').forEach((page) => { page.hidden = page.dataset.page !== state.view && !(['new-task', 'inbox'].includes(state.view) && page.dataset.page === 'tasks'); });
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach((link) => link.classList.toggle('active', link.dataset.nav === state.view));
  const title: Record<View, [string, string]> = {
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
  document.querySelectorAll<HTMLElement>('[data-settings-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== state.settingsSection;
  });
  document.querySelectorAll<HTMLElement>('[data-settings-target]').forEach((button) => {
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
  els.bugList.innerHTML = state.bugs.map((bug) => `
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
    ? (bug.attachments || []).map((item, index) => `<button class="button ghost" type="button" data-attachment-preview="${index}">${escapeHtml(item.name || '附件')}</button>`).join('')
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

async function bugAction(event: MouseEvent) {
  const target = event.target as Element | null;
  const item = target?.closest<HTMLElement>('[data-bug-id]');
  if (item?.dataset.bugId) { state.selectedBugId = item.dataset.bugId; render(); return; }
  if (target?.closest('[data-create-task]')) return createTaskFromSelectedBug();
  if (target?.closest('[data-load-attachments]')) return loadBugAttachments();
  if (target?.closest('[data-assignment-recommend]')) return refreshAssignmentRecommendation();
  if (target?.closest('[data-assignment-apply]')) return applyAssignmentRecommendation();
  const preview = target?.closest<HTMLElement>('[data-attachment-preview]');
  if (preview) openAttachmentPreview(Number(preview.dataset.attachmentPreview));
}

async function createTaskFromSelectedBug() {
  const bug = selectedBug();
  if (!bug) return showToast('请先选择一个缺陷');
  els.createTaskFromBug.disabled = true;
  try {
    const result = await api<{ taskId: string; existing?: boolean }>(`/api/bugs/${encodeURIComponent(bug.id)}/task`, { method: 'POST', body: '{}' });
    location.hash = 'tasks';
    await taskCenterUI.load();
    taskCenterUI.selectTask(result.taskId);
    showToast(result.existing ? '该缺陷已有任务，已为你打开' : '已从缺陷生成任务');
  } catch (error: unknown) { showToast(errorMessage(error)); }
  finally { els.createTaskFromBug.disabled = false; }
}

async function loadBugAttachments() {
  const bug = selectedBug(); if (!bug) return;
  try {
    const data = await api<{ attachments: Attachment[] }>(`/api/bugs/${encodeURIComponent(bug.id)}/attachments`);
    bug.attachments = data.attachments; bug.attachmentsLoaded = true; renderBugDetail();
  } catch (error: unknown) { showToast(errorMessage(error)); }
}

function openAttachmentPreview(index: number) {
  const item = selectedBug()?.attachments?.[index]; if (!item?.url) return;
  const modal = select<HTMLElement>('#attachmentPreviewModal'), image = select<HTMLImageElement>('#attachmentPreviewImage');
  select('#attachmentPreviewTitle').textContent = item.name || '图片预览';
  select<HTMLAnchorElement>('#attachmentPreviewDownload').href = item.url;
  image.src = item.url; image.alt = item.name || '附件';
  modal.hidden = false;
}
function closeAttachmentPreview() { select<HTMLElement>('#attachmentPreviewModal').hidden = true; select<HTMLImageElement>('#attachmentPreviewImage').removeAttribute('src'); }

async function syncNow() {
  els.syncNow.disabled = true;
  try { applyBootstrap(await api<BootstrapData>('/api/sync', { method: 'POST' })); showToast(state.scheduler.lastRunMessage); }
  catch (error: unknown) { showToast(errorMessage(error)); }
  finally { els.syncNow.disabled = false; }
}

async function refreshAssignmentRecommendation() {
  const bug = selectedBug(); if (!bug) return;
  try {
    const data = await api<{ bug: Bug }>(`/api/bugs/${encodeURIComponent(bug.id)}/assignment/recommend`, { method: 'POST', body: '{}' });
    Object.assign(bug, data.bug); renderBugDetail();
  } catch (error: unknown) { showToast(errorMessage(error)); }
}
async function applyAssignmentRecommendation() {
  const bug = selectedBug(); if (!bug) return;
  try {
    const data = await api<{ bug: Bug }>(`/api/bugs/${encodeURIComponent(bug.id)}/assignment/apply`, { method: 'POST', body: '{}' });
    Object.assign(bug, data.bug); renderBugDetail(); showToast('分配完成');
  } catch (error: unknown) { showToast(errorMessage(error)); }
}
async function applyAllAssignments() {
  try { applyBootstrap(await api<BootstrapData>('/api/assignments/apply-all', { method: 'POST', body: '{}' })); showToast('批量分配完成'); }
  catch (error: unknown) { showToast(errorMessage(error)); }
}

function renderConfig() {
  if (!state.config || configFormDirty) return;
  for (const field of els.configForm.elements) {
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) continue;
    if (!field.name || !Object.hasOwn(state.config, field.name)) continue;
    if (field instanceof HTMLInputElement && field.type === 'checkbox') field.checked = Boolean(state.config[field.name]);
    else field.value = String(state.config[field.name] ?? '');
  }
  select('#workspacePolicy').hidden = !state.config.workspaceManaged;
  select('#credentialState').textContent = state.config.issueSourceConfigured ? `${state.config.issueSourceLabel} 已配置` : `${state.config.issueSourceLabel || '数据源'} 未配置`;
  select('#sidebarCredentialText').textContent = state.config.issueSourceConfigured ? '数据源已连接' : '数据源未配置';
  select('#sidebarCredentialDot').classList.toggle('online', Boolean(state.config.issueSourceConfigured));
  els.toggleScheduler.textContent = state.scheduler.enabled ? '关闭定时' : '开启定时';
}
async function saveConfig(event: SubmitEvent) {
  event.preventDefault();
  const form = new FormData(els.configForm), payload: Record<string, FormDataEntryValue | number | boolean> = Object.fromEntries(form.entries());
  payload.intervalMinutes = Number(payload.intervalMinutes);
  payload.openaiTimeoutMs = Number(payload.openaiTimeoutMs);
  payload.selfOnly = form.get('selfOnly') === 'true';
  payload.enableAIAssignment = form.get('enableAIAssignment') === 'true';
  payload.enableAutoAssignment = form.get('enableAutoAssignment') === 'true';
  try { configFormDirty = false; applyBootstrap(await api<BootstrapData>('/api/config', { method: 'PUT', body: JSON.stringify(payload) })); showToast('配置已保存'); }
  catch (error: unknown) { showToast(errorMessage(error)); }
}
async function toggleScheduler() {
  try { applyBootstrap(await api<BootstrapData>('/api/scheduler', { method: 'POST', body: JSON.stringify({ enabled: !state.scheduler.enabled }) })); }
  catch (error: unknown) { showToast(errorMessage(error)); }
}

function renderAssignmentPeople() {
  select('#assignmentPeopleState').textContent = `${state.assignmentPeople.length} 人`;
  els.assignmentPeopleList.innerHTML = state.assignmentPeople.map((person) => `
    <div class="member-card" data-person-id="${escapeHtml(person.employeeId)}">
      <label>姓名<input name="personName" value="${escapeHtml(person.name)}"></label>
      <label>员工号<input name="personEmployeeId" value="${escapeHtml(person.employeeId)}"></label>
      <label>职责<textarea name="personResponsibility">${escapeHtml(person.responsibility)}</textarea></label>
      <button class="button secondary" type="button" data-save-person>保存</button>
      <button class="button ghost" type="button" data-delete-person>删除</button>
    </div>`).join('') || '<div class="empty">尚未配置人员。</div>';
}
async function addAssignmentPerson(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const values = Object.fromEntries(new FormData(form));
  const person: AssignmentPerson = { name: String(values.name ?? ''), employeeId: String(values.employeeId ?? ''), responsibility: String(values.responsibility ?? '') };
  await saveAssignmentPeople([...state.assignmentPeople.filter((item) => item.employeeId !== person.employeeId), person]);
  form.reset();
}
async function assignmentPeopleAction(event: MouseEvent) {
  const target = event.target as Element | null;
  const card = target?.closest<HTMLElement>('[data-person-id]'); if (!card) return;
  const id = card.dataset.personId;
  if (target?.closest('[data-delete-person]')) return saveAssignmentPeople(state.assignmentPeople.filter((item) => item.employeeId !== id));
  if (target?.closest('[data-save-person]')) {
    const person = { name: card.querySelector<HTMLInputElement>('[name=personName]')!.value.trim(), employeeId: card.querySelector<HTMLInputElement>('[name=personEmployeeId]')!.value.trim(), responsibility: card.querySelector<HTMLTextAreaElement>('[name=personResponsibility]')!.value.trim() };
    return saveAssignmentPeople([...state.assignmentPeople.filter((item) => item.employeeId !== id && item.employeeId !== person.employeeId), person]);
  }
}
async function saveAssignmentPeople(people: AssignmentPerson[]) {
  try { applyBootstrap(await api<BootstrapData>('/api/assignment/people', { method: 'PUT', body: JSON.stringify({ people }) })); showToast('分配规则已保存'); }
  catch (error: unknown) { showToast(errorMessage(error)); }
}

function bindHistoryEvents() {
  select('#historyFilters').addEventListener('submit', (event) => {
    event.preventDefault();
    historyState.agent = select<HTMLSelectElement>('#historyAgent').value;
    historyState.query = select<HTMLInputElement>('#historyQuery').value.trim();
    historyState.workspace = select<HTMLSelectElement>('#historyWorkspace').value;
    loadAgentHistory(0);
  });
  for (const selector of ['#historyAgent', '#historyWorkspace']) {
    select(selector).addEventListener('change', () => select<HTMLFormElement>('#historyFilters').requestSubmit());
  }
  select('#historyPrev').addEventListener('click', () => loadAgentHistory(Math.max(0, historyState.offset - 30)));
  select('#historyNext').addEventListener('click', () => loadAgentHistory(historyState.offset + 30));
  select('#historyList').addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLElement>('[data-session-id]');
    const id = button?.dataset.sessionId;
    if (id) { history.replaceState(null, '', `#history/${id}`); loadAgentSession(id); }
  });
  select('#historyDetail').addEventListener('click', (event) => {
    if ((event.target as Element | null)?.closest('[data-more-messages]') && historyState.detail && historyState.selected) {
      loadAgentSession(historyState.selected, historyState.detail.messages.length);
    }
  });
}

const historyStatusLabel = (value: unknown) => ({ ready: '等待输入', preparing: '正在准备上下文', queued: '等待执行', launching: '正在连接', running: '正在回复', waiting: '等待处理', failed: '执行失败', completed: '本轮结束', interrupted: '已中断', error: '发生错误', unknown: '运行状态未知' } as Record<string, string>)[String(value)] || '运行状态未知';
const historyTime = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '时间未知';

async function loadAgentHistory(offset = historyState.offset) {
  historyComposer.unmount();
  const request = ++historyState.listRequest;
  ++historyState.detailRequest;
  historyState.selected = null;
  historyState.detail = null;
  select('#historyDetail').innerHTML = '<div class="history-empty"><span>◎</span><h2>从一个会话开始</h2><p>选择历史会话，查看对话与工作过程</p></div>';
  select('#historyStatus').textContent = '正在读取历史会话，首次索引可能需要一些时间…';
  select('#historyList').replaceChildren();
  select<HTMLButtonElement>('#historyPrev').disabled = true;
  select<HTMLButtonElement>('#historyNext').disabled = true;
  try {
    const query = new URLSearchParams({ offset: String(offset), limit: '30', agent: historyState.agent, q: historyState.query, workspace: historyState.workspace });
    const data = await api<HistoryListResponse>(`/api/agent-sessions?${query}`);
    if (request !== historyState.listRequest) return;
    historyState.offset = data.offset;
    historyState.total = data.total;
    const sourceLabels: Record<string, string> = { available: '可读取', missing: '未找到历史目录', unconfigured: '未配置', error: '无法读取目录' };
    select('#historySources').textContent = `${data.scope === 'all' ? '全部本地工作区' : '仅组织工作目录'} · ${data.providers.map((provider) => `${provider.label}：${sourceLabels[provider.status] || provider.status}${provider.skipped ? `（${provider.skipped} 项未能读取）` : ''}`).join(' · ')}`;
    select<HTMLSelectElement>('#historyAgent').innerHTML = '<option value="">全部 Agent</option>' + data.providers.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.label)}</option>`).join('');
    select<HTMLSelectElement>('#historyAgent').value = historyState.agent;
    select<HTMLSelectElement>('#historyWorkspace').innerHTML = '<option value="">全部工作区</option>' + data.workspaces.map((workspace) => `<option value="${escapeHtml(workspace.path)}">${escapeHtml(workspace.path === '__unknown__' ? '未知工作区' : workspace.path)} (${workspace.count})</option>`).join('');
    if (historyState.workspace && !data.workspaces.some((workspace) => workspace.path === historyState.workspace)) {
      const option = document.createElement('option');
      option.value = historyState.workspace;
      option.textContent = historyState.workspace + ' (0)';
      select<HTMLSelectElement>('#historyWorkspace').append(option);
    }
    select<HTMLSelectElement>('#historyWorkspace').value = historyState.workspace;
    select('#historyStatus').textContent = data.total ? `共 ${data.total} 个会话，按最近更新时间排序` : '没有匹配的会话，试试其他工作区或搜索词。';
    select('#historyList').innerHTML = data.sessions.map((session) => `<button class="history-card" type="button" data-session-id="${escapeHtml(session.id)}" aria-pressed="false">
      <strong>${escapeHtml(session.title)}</strong>
      <span class="history-meta">${escapeHtml(session.agentLabel)} · ${historyTime(session.updatedAt)}</span>
      <span>${escapeHtml(historyStatusLabel(session.status))} · ${session.messageCount} 条记录${session.managed ? ' · 已继承上下文' : ''}${session.archived ? ' · 已归档' : ''}${session.partial ? ' · 部分记录' : ''}</span>
      <span class="history-meta">${escapeHtml(session.cwd?.split('/').filter(Boolean).at(-1) || '未知工作区')}${session.branch ? ' · ' + escapeHtml(session.branch) : ''}</span></button>`).join('');
    select('#historyPage').textContent = data.total ? `${data.offset + 1}–${Math.min(data.offset + data.limit, data.total)} / ${data.total}` : '0 / 0';
    select<HTMLButtonElement>('#historyPrev').disabled = data.offset === 0;
    select<HTMLButtonElement>('#historyNext').disabled = data.offset + data.limit >= data.total;
  } catch (error: unknown) {
    if (request === historyState.listRequest) select('#historyStatus').textContent = `加载失败：${errorMessage(error)}`;
  }
}

// Refresh only the transcript; keep the composer, focus and unsent draft mounted.
async function syncAgentSession(id: string) {
  const request = historyState.detailRequest;
  const messages: HistoryMessage[] = [];
  let data: HistoryDetail;
  do {
    data = await api<HistoryDetail>(`/api/agent-sessions/${encodeURIComponent(id)}?offset=${messages.length}&limit=200`);
    messages.push(...data.messages);
  } while (messages.length < data.total && data.messages.length);
  if (request !== historyState.detailRequest || historyState.selected !== id) return null;
  historyState.detail = { ...data, messages };
  const transcript = document.querySelector<HTMLElement>('#historyDetail [data-history-transcript]');
  const scroll = transcript?.closest('.history-chat-scroll');
  const follow = scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  if (transcript) {
    const html = renderMessages(messages);
    if (transcript.innerHTML !== html) transcript.innerHTML = html;
  }
  const footer = document.querySelector<HTMLElement>('#historyDetail .history-chat-footer');
  if (footer) footer.innerHTML = `<span>已显示 ${messages.length} / ${data.total} 条记录</span>${messages.length < data.total ? '<button class="button secondary" type="button" data-more-messages>加载更多记录</button>' : ''}`;
  if (follow) scroll.scrollTop = scroll.scrollHeight;
  return messages;
}

async function loadAgentSession(id: string, offset = 0) {
  historyComposer.unmount();
  const request = ++historyState.detailRequest;
  historyState.selected = id;
  const panel = select<HTMLElement>('#historyDetail');
  if (!offset) {
    historyState.detail = null;
    panel.textContent = '正在读取会话…';
  } else {
    const button = panel.querySelector<HTMLButtonElement>('[data-more-messages]');
    if (button) button.disabled = true;
  }
  document.querySelectorAll<HTMLElement>('[data-session-id]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.sessionId === id)));
  try {
    const data = await api<HistoryDetail>(`/api/agent-sessions/${encodeURIComponent(id)}?offset=${offset}&limit=100`);
    if (request !== historyState.detailRequest) return;
    const previousMessages = offset ? historyState.detail?.messages ?? [] : [];
    historyState.detail = { ...data, messages: [...previousMessages, ...data.messages] };
    const { session, messages, total } = historyState.detail;
    const duration = Math.max(0, Date.parse(session.updatedAt) - Date.parse(session.createdAt));
    const durationText = Number.isFinite(duration) ? `${Math.floor(duration / 60000)} 分钟 ${Math.floor(duration / 1000) % 60} 秒` : '未知';
    panel.innerHTML = `<header class="history-chat-header"><div><h2>${escapeHtml(session.title)}</h2><span>${escapeHtml(session.agentLabel)} · ${escapeHtml(session.cwd?.split('/').filter(Boolean).at(-1) || '未知工作区')}</span></div><span class="history-readonly">${(session.managed || (session.agent === 'codex' && (!session.deviceId || session.deviceId === 'local'))) && state.permissions.includes('work.execute') && !session.archived ? '可续聊' : '只读'}</span></header>
      <div class="history-chat-scroll"><div class="history-chat-content"><details class="history-session-info"><summary>会话跨度 ${durationText}<span>›</span></summary>
      <dl class="history-info"><dt>会话 ID</dt><dd>${escapeHtml(session.sessionId || session.id)}</dd><dt>工作目录</dt><dd>${escapeHtml(session.workspaces?.join('、') || session.cwd || '未知')}</dd><dt>模型 / 分支</dt><dd>${escapeHtml(session.model || '未知')} / ${escapeHtml(session.branch || '未知')}</dd><dt>记录状态</dt><dd>${escapeHtml(historyStatusLabel(session.status))}</dd><dt>创建 / 更新</dt><dd>${historyTime(session.createdAt)} / ${historyTime(session.updatedAt)}</dd></dl></details>
      ${session.partial ? '<p class="history-warning">部分记录损坏、尚未写完或超出读取上限，当前展示部分内容。</p>' : ''}
      ${data.inherited ? `<details class="history-inherited"><summary>接续自原会话 · ${data.inherited.count} 条上下文${data.inherited.partial ? " · 部分记录" : ""}</summary><div data-inherited-records></div><button type="button" class="button secondary" data-inherited-more>查看继承记录</button></details>` : ''}
      <div class="history-messages" data-history-transcript>${renderMessages(messages)}</div>
      <div class="history-chat-footer"><span>已显示 ${messages.length} / ${total} 条记录</span>${messages.length < total ? '<button class="button secondary" type="button" data-more-messages>加载更多记录</button>' : ''}</div><div id="historyLiveOutput" class="history-messages" role="log" aria-live="polite"></div></div></div><section class="history-composer" id="historyComposer" aria-label="会话输入框"></section>`;
    let inheritedOffset = 0;
    const inheritedButton = panel.querySelector<HTMLButtonElement>('[data-inherited-more]');
    if (inheritedButton) inheritedButton.addEventListener('click', async () => {
      inheritedButton.disabled = true;
      try {
        const inherited = await api<{ messages: HistoryMessage[]; total: number }>(`/api/conversations/${id}/inherited?offset=${inheritedOffset}`);
        if (request !== historyState.detailRequest) return;
        panel.querySelector<HTMLElement>('[data-inherited-records]')?.insertAdjacentHTML('beforeend', renderMessages(inherited.messages));
        inheritedOffset += inherited.messages.length; inheritedButton.hidden = inheritedOffset >= inherited.total;
        inheritedButton.textContent = '加载更多继承记录';
      } catch (error: unknown) { showToast(errorMessage(error)); }
      finally { inheritedButton.disabled = false; }
    });
    historyComposer.mount(select('#historyComposer'), session, select('#historyLiveOutput'), messages);
  } catch (error: unknown) {
    if (request !== historyState.detailRequest) return;
    if (!offset) panel.textContent = `加载失败：${errorMessage(error)}`;
    else {
      showToast(errorMessage(error));
      const button = panel.querySelector<HTMLButtonElement>('[data-more-messages]');
      if (button) button.disabled = false;
    }
  }
}

function selectedBug() { return state.bugs.find((bug) => bug.id === state.selectedBugId) || null; }
function configurePolling() {
  const pending = state.bugs.some((bug) => ['pending', 'assigning'].includes(bug.assignmentRecommendation?.status ?? ''));
  if (pending && !pollTimer) pollTimer = setInterval(() => loadBootstrap({ silent: true }).catch(() => {}), 3000);
  if (!pending && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
function currentView(): View {
  const view = location.hash.replace(/^#/, '') || 'tasks';
  if (view === 'settings' || view.startsWith('settings/') || ['assignment', 'config', 'members', 'account'].includes(view)) return 'settings';
  if (view.startsWith('history/')) return 'history';
  const views: View[] = ['tasks', 'new-task', 'workbench', 'history', 'inbox'];
  return views.includes(view as View) ? view as View : 'tasks';
}
function currentSettingsSection(): SettingsSection {
  const route = location.hash.replace(/^#/, '');
  const section = route.startsWith('settings/') ? route.slice('settings/'.length) : route;
  const sections: SettingsSection[] = ['assignment', 'config', 'members', 'account'];
  return sections.includes(section as SettingsSection) ? section as SettingsSection : 'assignment';
}
function showToast(message: unknown) {
  els.toast.textContent = String(message || ''); els.toast.classList.add('show');
  setTimeout(() => els.toast.classList.remove('show'), 2400);
}
async function api<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
  const token = sessionStorage.getItem('bugflow.sessionToken');
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) sessionStorage.removeItem('bugflow.sessionToken');
    const message = typeof data === 'object' && data !== null && 'message' in data && typeof data.message === 'string' ? data.message : `请求失败：${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return data as T;
}
