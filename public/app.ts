import { createTaskCenterUI } from './taskCenter.js';

type View = 'tasks' | 'new-task' | 'workbench' | 'history' | 'inbox' | 'settings';
type SettingsSection = 'assignment' | 'config' | 'members' | 'account';
type UserRole = 'owner' | 'admin' | 'operator' | 'viewer';
interface User { username: string; displayName: string; role: UserRole }
interface AppConfig { issueSourceConfigured?: boolean; [key: string]: unknown }
interface BootstrapData {
  tenant?: { id: string; name: string }; user?: User; permissions?: string[]; config?: AppConfig;
}
interface AppState {
  user: User | null; permissions: string[]; config: AppConfig;
  view: View; settingsSection: SettingsSection;
}
function select<T extends Element = HTMLElement>(selector: string): T {
  return document.querySelector<T>(selector) as T;
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const roleLabel = (role: string) => ({ owner: '组织所有者', admin: '管理员', operator: '操作员', viewer: '只读成员' } as Record<string, string>)[role] || role;
const state: AppState = {
  user: null, permissions: [], config: {},
  view: currentView(), settingsSection: currentSettingsSection()
};
const toast = select<HTMLElement>('#toast');
const taskCenterUI = createTaskCenterUI({
  root: select('#taskCenter'), api,
  canEdit: () => state.permissions.includes('work.execute'),
  toast: showToast
});
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
    const message = errorMessage(error);
    (window as Window & { __bugflowAuthError?: string }).__bugflowAuthError = message;
    window.dispatchEvent(new CustomEvent('bugflow:auth-required', { detail: { message } }));
  }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  sessionStorage.removeItem('bugflow.sessionToken');
  location.reload();
}

function bindEvents() {
  window.addEventListener('bugflow:settings-updated', (event) => {
    const data = (event as CustomEvent<BootstrapData>).detail;
    if (data) applyBootstrap(data);
  });
  window.addEventListener('bugflow:open-task', async (event) => {
    const { taskId, existing } = (event as CustomEvent<{ taskId?: string; existing?: boolean }>).detail || {};
    if (!taskId) return;
    location.hash = 'tasks';
    await taskCenterUI.load();
    taskCenterUI.selectTask(taskId);
    showToast(existing ? '该缺陷已有任务，已为你打开' : '已从缺陷生成任务');
  });
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
}

async function loadCurrentView() {
  if (['tasks', 'new-task', 'inbox'].includes(state.view)) {
    await taskCenterUI.load();
    if (state.view === 'new-task') await taskCenterUI.openNew();
    else if (state.view === 'inbox') taskCenterUI.showInbox();
    else taskCenterUI.showTasks();
  }
}

async function loadBootstrap({ silent = false }: { silent?: boolean } = {}) {
  applyBootstrap(await api<BootstrapData>('/api/bootstrap'));
  if (!silent) showToast('工作台已加载');
}

function applyBootstrap(data: BootstrapData) {
  Object.assign(state, {
    user: data.user || state.user, permissions: data.permissions || state.permissions,
    config: data.config || {}
  });
  select('#tenantName').textContent = `${data.tenant?.name || ''} (${data.tenant?.id || ''})`;
  if (state.user) select('#currentUser').textContent = `${state.user.displayName} · ${roleLabel(state.user.role)}`;
  select('#sidebarCredentialText').textContent = state.config.issueSourceConfigured ? '数据源已连接' : '数据源未配置';
  select('#sidebarCredentialDot').classList.toggle('online', Boolean(state.config.issueSourceConfigured));
  const identity = { user: state.user, permissions: state.permissions, data };
  (window as Window & { __bugflowIdentity?: typeof identity }).__bugflowIdentity = identity;
  window.dispatchEvent(new CustomEvent('bugflow:bootstrap', { detail: identity }));
  renderPermissions();
  render();
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
  renderSettings();
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
  toast.textContent = String(message || ''); toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
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
