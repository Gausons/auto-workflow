import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { createBrowserRouter, Link, Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { apiRequest, clearSessionToken, hasSessionToken } from '../api/client.js';
import { AuthScreen } from '../auth/AuthScreen.js';
import { AccountPanel } from '../account/AccountPanel.js';
import { MembersPanel } from '../members/MembersPanel.js';
import { WorkbenchPage } from '../workbench/WorkbenchPage.js';
import { HistoryPage } from '../history/HistoryPage.js';
import { AssignmentPanel, ConfigPanel } from '../settings/SettingsPanels.js';
import { TaskAuxPage } from '../tasks/TaskAuxPage.js';
import { TaskPage, rememberTask } from '../tasks/TaskPage.js';
import { NewTaskPage, rememberSourceSession } from '../tasks/NewTaskPage.js';

interface Identity { username: string; displayName: string; role: 'owner' | 'admin' | 'operator' | 'viewer' }
interface Bootstrap { tenant?: { id: string; name: string }; user?: Identity; permissions?: string[]; config?: { issueSourceConfigured?: boolean; [key: string]: unknown } }
const roleLabel: Record<string, string> = { owner: '组织所有者', admin: '管理员', operator: '操作员', viewer: '只读成员' };
const titles: Record<string, [string, string]> = {
  '/tasks': ['任务中心', '跨设备、跨 Agent 管理工作'], '/tasks/new': ['新建任务', '描述目标并选择 Agent'], '/inbox': ['未归属会话', '将历史会话关联到任务'], '/devices': ['设备与 Agent', '查看连接状态与可用执行目标'],
  '/workbench': ['缺陷工作台', '同步缺陷并直接生成 Agent 任务'], '/history': ['Agent 历史会话', '查看本地 Agent 工作记录'], '/settings': ['设置', '管理工作台和组织偏好']
};

function pathForHash(hash: string) {
  const value = hash.replace(/^#/, '');
  if (value === 'new-task') return '/tasks/new';
  if (['tasks', 'inbox', 'devices', 'workbench', 'history'].includes(value)) return `/${value}`;
  if (/^history\/[a-f0-9]{64}$/.test(value)) return `/${value}`;
  if (value === 'settings') return '/settings/assignment';
  if (/^settings\/(assignment|config|members|account)$/.test(value)) return `/${value}`;
  if (['assignment', 'config', 'members', 'account'].includes(value)) return `/settings/${value}`;
  return null;
}

const initialPath = pathForHash(location.hash);
if (initialPath) history.replaceState(history.state, '', initialPath);

function RouteRefresh({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return <div key={location.pathname}>{children}</div>;
}

function SettingsPage() {
  const { section } = useParams();
  const current = ['assignment', 'config', 'members', 'account'].includes(section || '') ? section : 'assignment';
  const items = [
    ['assignment', '⌁', '分配规则', '人员与职责'], ['config', '⇄', '对接配置', '数据源与执行'],
    ['members', '♙', '组织成员', '角色与权限'], ['account', '○', '我的账号', '登录与安全']
  ];
  return <section className="page settings-page"><header className="page-heading settings-heading"><div><h1>设置</h1><p>管理分配策略、外部服务、组织成员与个人账号</p></div></header><div className="settings-layout"><nav className="settings-nav" aria-label="设置导航">{items.map(([id, icon, title, subtitle]) => <Link key={id} to={`/settings/${id}`} className={current === id ? 'active' : ''} aria-current={current === id ? 'page' : undefined}><span aria-hidden="true">{icon}</span><span><strong>{title}</strong><small>{subtitle}</small></span></Link>)}</nav><div className="settings-content"><div className="settings-panel">{current === 'assignment' ? <AssignmentPanel /> : current === 'config' ? <ConfigPanel /> : current === 'members' ? <MembersPanel /> : <AccountPanel />}</div></div></div></section>;
}

function Shell() {
  const bootstrap = useQuery({ queryKey: ['app', 'bootstrap'], queryFn: ({ signal }) => apiRequest<Bootstrap>('/api/bootstrap', { signal }) }).data!;
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const view = location.pathname === '/tasks/new' ? 'new-task' : location.pathname.startsWith('/history') ? 'history' : location.pathname.startsWith('/settings') ? 'settings' : location.pathname.slice(1) || 'tasks';
  const title = location.pathname.startsWith('/history') ? titles['/history'] : location.pathname.startsWith('/settings') ? titles['/settings'] : titles[location.pathname] || titles['/tasks'];
  useEffect(() => {
    document.body.dataset.view = view;
    const permissions = bootstrap.permissions || [];
    document.body.dataset.canExecute = String(permissions.includes('work.execute'));
    document.body.dataset.canConfigure = String(permissions.includes('config.manage'));
    document.body.dataset.canManagePeople = String(permissions.includes('people.manage'));
    document.body.dataset.canManageMembers = String(permissions.includes('members.manage'));
  }, [view, bootstrap.permissions]);
  useEffect(() => {
    const identity = { user: bootstrap.user, permissions: bootstrap.permissions || [], data: bootstrap };
    (window as Window & { __bugflowIdentity?: typeof identity }).__bugflowIdentity = identity;
    window.dispatchEvent(new CustomEvent('bugflow:bootstrap', { detail: identity }));
  }, [bootstrap]);
  useEffect(() => {
    const legacy = () => { const path = pathForHash(window.location.hash); if (path) navigate(path); };
    const openTask = (event: Event) => {
      const detail = (event as CustomEvent<{ taskId?: string }>).detail;
      if (detail?.taskId) { rememberTask(detail.taskId); navigate('/tasks'); }
    };
    const newTask = (event: Event) => {
      const id = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (id) { rememberSourceSession(id); navigate('/tasks/new'); }
    };
    const updated = (event: Event) => {
      const data = (event as CustomEvent<Bootstrap>).detail;
      if (data) queryClient.setQueryData<Bootstrap>(['app', 'bootstrap'], previous => ({ ...previous, ...data, user: data.user || previous?.user, tenant: data.tenant || previous?.tenant }));
    };
    window.addEventListener('hashchange', legacy);
    window.addEventListener('bugflow:open-task', openTask);
    window.addEventListener('bugflow:create-task-from-session', newTask);
    window.addEventListener('bugflow:settings-updated', updated);
    return () => { window.removeEventListener('hashchange', legacy); window.removeEventListener('bugflow:open-task', openTask); window.removeEventListener('bugflow:create-task-from-session', newTask); window.removeEventListener('bugflow:settings-updated', updated); };
  }, [navigate, queryClient]);
  async function logout() {
    try { await apiRequest('/api/auth/logout', { method: 'POST' }); } catch { /* local logout still clears the session */ }
    clearSessionToken(); window.location.assign('/tasks');
  }
  return <div className="app-shell" id="workspaceShell"><aside className="sidebar"><div className="brand"><svg className="brand-mark" viewBox="0 0 36 36" aria-hidden="true"><rect x="4" y="5" width="28" height="26" rx="6" /><path d="M11 14h18M11 21h10M24 20l4 4-4 4" /></svg><div><strong>BugFlow</strong><span>多设备 Agent 工作台</span></div></div>
    <nav className="nav-list" aria-label="主导航"><Link className={`nav-create-task ${view === 'new-task' ? 'active' : ''}`} to="/tasks/new"><span className="nav-icon" aria-hidden="true">＋</span><span>新建任务</span></Link><Link className={['tasks', 'inbox', 'devices'].includes(view) ? 'active' : ''} to="/tasks"><span className="nav-icon" aria-hidden="true">▣</span><span>任务中心</span></Link><Link className={view === 'workbench' ? 'active' : ''} to="/workbench"><span className="nav-icon" aria-hidden="true">◇</span><span>缺陷工作台</span></Link><Link className={view === 'history' ? 'active' : ''} to="/history"><span className="nav-icon" aria-hidden="true">◷</span><span>Agent 历史会话</span></Link></nav>
    <Link className={`settings-link ${view === 'settings' ? 'active' : ''}`} to="/settings/assignment"><span className="nav-icon" aria-hidden="true">⚙</span><span>设置</span></Link><div className="sidebar-note"><span className={`status-dot ${bootstrap.config?.issueSourceConfigured ? 'online' : ''}`} /><span>{bootstrap.config?.issueSourceConfigured ? '数据源已连接' : '数据源未配置'}</span></div><div className="tenant-panel"><span>当前团队</span><strong>{bootstrap.tenant?.name || ''} ({bootstrap.tenant?.id || ''})</strong><span>{bootstrap.user?.displayName || ''} · {roleLabel[bootstrap.user?.role || ''] || ''}</span><button className="button secondary" type="button" onClick={() => void logout()}>退出 / 切换团队</button></div></aside>
    <main className="main"><header className="topbar"><div><p className="eyebrow">{title[1]}</p><h1>{title[0]}</h1></div><div className="top-actions" id="workbenchActions" /></header><Outlet /></main></div>;
}

function AppRoot() {
  const bootstrap = useQuery({ queryKey: ['app', 'bootstrap'], queryFn: ({ signal }) => apiRequest<Bootstrap>('/api/bootstrap', { signal }), enabled: hasSessionToken(), retry: false });
  if (!hasSessionToken() || bootstrap.isError) return <section className="login-screen" id="loginScreen"><AuthScreen hasSession={false} /></section>;
  if (bootstrap.isPending) return <section className="login-screen" id="loginScreen"><div className="login-card" role="status">正在加载工作台…</div></section>;
  return <RouterProvider router={router} />;
}

function createRouter() {
  return createBrowserRouter([{ path: '/', element: <Shell />, errorElement: <div role="alert">页面加载失败，请刷新后重试。</div>, children: [
    { index: true, element: <Navigate to="/tasks" replace /> },
    { path: 'tasks', element: <section className="page task-center" aria-label="任务中心"><TaskPage /></section> },
    { path: 'tasks/new', element: <section className="page task-center"><NewTaskPage /></section> },
    { path: 'inbox', element: <section className="page task-center"><TaskAuxPage /></section> },
    { path: 'devices', element: <section className="page task-center"><TaskAuxPage /></section> },
    { path: 'workbench', element: <section className="page"><WorkbenchPage /></section> },
    { path: 'history', element: <section className="page history-page"><RouteRefresh><HistoryPage /></RouteRefresh></section> },
    { path: 'history/:id', element: <section className="page history-page"><RouteRefresh><HistoryPage /></RouteRefresh></section> },
    { path: 'settings', element: <Navigate to="/settings/assignment" replace /> },
    { path: 'settings/:section', element: <SettingsPage /> },
    { path: '*', element: <Navigate to="/tasks" replace /> }
  ] }]);
}

const router = createRouter();
export function App() { return <AppRoot />; }
