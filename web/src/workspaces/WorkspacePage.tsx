import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { apiRequest } from '../api/client.js';
import type { TaskCenterData } from '../../../shared/taskTypes.js';
import { enterWorkspace, roleLabels, useWorkspaces, type Invitation, type WorkspaceMember, type WorkspaceRole } from './workspaceApi.js';
import styles from './Workspace.module.css';

const taskLabels = { waiting: '等待输入', error: '执行异常', running: '进行中', ready: '待接续', review: '待验收', completed: '已完成' };
const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function WorkspacePage() {
  const spaces = useWorkspaces();
  const client = useQueryClient();
  const [tab, setTab] = useState<'overview' | 'members'>('overview');
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const requestId = useRef('');
  const current = spaces.data?.workspaces.find(item => item.id === spaces.data.currentId);
  const team = current?.kind === 'team';
  const canManage = current?.role === 'owner' || current?.role === 'admin';
  const canExecute = current?.role !== 'viewer';
  const members = useQuery({ queryKey: ['workspaces', 'members', current?.id], queryFn: ({ signal }) => apiRequest<{ members: WorkspaceMember[]; invitations: Invitation[] }>('/api/workspaces/members', { signal }), enabled: team, refetchInterval: 30_000 });
  const tasks = useQuery({ queryKey: ['task-center', 'snapshot'], queryFn: ({ signal }) => apiRequest<TaskCenterData>('/api/task-center', { signal }), enabled: Boolean(current), refetchInterval: 15_000 });
  const identity = useQuery({ queryKey: ['app', 'bootstrap'], queryFn: ({ signal }) => apiRequest<{ user: { id: string; displayName: string } }>('/api/bootstrap', { signal }) });
  const action = useMutation({
    mutationFn: async ({ path, method = 'POST', body }: { path: string; method?: string; body?: unknown }) => apiRequest<{ id?: string }>(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }),
    onError: () => { void client.invalidateQueries({ queryKey: ['workspaces'] }); },
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['workspaces'] }); },
  });
  const switching = useMutation({ mutationFn: enterWorkspace });
  const error = action.error || switching.error;
  const busy = action.isPending || switching.isPending;
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const result = await action.mutateAsync({ path: '/api/workspaces', body: { name: data.get('name'), requestId: requestId.current } });
      setCreating(false); setNotice('团队空间已创建，可在下方进入。');
      if (result.id) switching.mutate(result.id);
    } catch { /* Error stays visible and the same request ID can be retried. */ }
  }
  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    try {
      await action.mutateAsync({ path: '/api/workspaces/invitations', body: { username: data.get('username'), role: data.get('role') } });
      form.reset(); setNotice('站内邀请已创建，对方可在协作空间页面接受。');
    } catch { /* Preserve the form on failure. */ }
  }
  const visibleTasks = (tasks.data?.tasks || []).filter(task => task.title.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const recentActivity = (tasks.data?.tasks || []).flatMap(task => task.events.map(event => ({ ...event, title: task.title, taskId: task.id }))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5);
  function openTask(taskId: string) { window.dispatchEvent(new CustomEvent('bugflow:open-task', { detail: { taskId } })); }
  if (spaces.isPending) return <div className={styles.loading} role="status">正在加载协作空间…</div>;
  if (spaces.isError) return <div className={styles.loading} role="alert">无法加载协作空间。<button type="button" onClick={() => void spaces.refetch()}>重试</button></div>;
  return <section className={styles.page} aria-label="协作空间">
    <header className={styles.topbar}><span>{team ? '团队空间' : '个人空间'} <span aria-hidden="true"> / </span> 概览</span><button type="button" className={styles.secondary} onClick={() => { requestId.current = crypto.randomUUID(); setCreating(true); action.reset(); }}>＋ 创建团队空间</button></header>
    <div className={styles.body}>
      <div className={styles.hero}><div><span className={styles.eyebrow}>AGENTFLOW WORKSPACE</span><h1>{team ? current.name : '让协作，从这里开始。'}</h1><p>{team ? '把目标、任务和 Agent 的工作汇聚在一起。' : '为团队建立一个共同推进工作的地方，个人工作仍留在自己的空间。'}</p></div><span className={styles.heroMark} aria-hidden="true">◈</span></div>
      {error && <p className={styles.error} role="alert">{error.message}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
      {creating && <form className={styles.formCard} onSubmit={event => void create(event)}><div><h2>创建团队空间</h2><p>新空间从空白开始，成员加入后共享空间内的任务、会话和设备。</p></div><label>空间名称<input name="name" autoFocus required maxLength={80} placeholder="例如：产品研发团队" /></label><div className={styles.actions}><button className={styles.primary} disabled={busy}>创建并进入</button><button type="button" className={styles.secondary} disabled={busy} onClick={() => setCreating(false)}>取消</button></div></form>}
      {Boolean(spaces.data?.invitations.length) && <section className={styles.incoming} aria-label="收到的邀请"><h2>邀请你一起协作</h2>{spaces.data?.invitations.map(invite => <div key={invite.id}><span><strong>{invite.name}</strong><small>邀请你以{roleLabels[invite.role]}身份加入 · 7 天内有效</small></span><button className={styles.primary} disabled={busy} onClick={() => action.mutate({ path: `/api/workspaces/invitations/${invite.id}/accept` }, { onSuccess: () => setNotice('已加入团队，可从空间列表进入。') })}>接受邀请</button></div>)}</section>}
      {!team && <section className={styles.spacesSection}><div className={styles.sectionHeading}><h2>你的团队空间</h2><span>{spaces.data?.workspaces.filter(item => item.kind === 'team').length || 0} 个空间</span></div><div className={styles.spaceGrid}>{spaces.data?.workspaces.filter(item => item.kind === 'team').map(space => <button key={space.id} type="button" disabled={busy} className={styles.spaceCard} onClick={() => switching.mutate(space.id)}><span className={styles.cardIcon} aria-hidden="true">◈</span><strong>{space.name}</strong><span>{roleLabels[space.role]} <span aria-hidden="true">↗</span></span></button>)}{spaces.data?.workspaces.length === 1 && <div className={styles.welcome}><span className={styles.cardIcon} aria-hidden="true">＋</span><h3>把下一件大事，一起做好</h3><p>创建团队，邀请同事，共享任务与上下文。<br />也可以等待同事的邀请，它会显示在这里。</p></div>}</div></section>}
      {team && <>
        <nav className={styles.tabs} aria-label="空间视图"><button type="button" aria-pressed={tab === 'overview'} onClick={() => setTab('overview')}>概览</button><button type="button" aria-pressed={tab === 'members'} onClick={() => setTab('members')}>成员 <span>{members.data?.members.filter(member => member.enabled).length ?? '—'}</span></button></nav>
        {tab === 'overview' ? <><div className={styles.stats}>{[['共享任务', tasks.data?.tasks.length], ['进行中', tasks.data?.tasks.filter(task => task.status === 'running').length], ['已完成', tasks.data?.tasks.filter(task => task.status === 'completed').length], ['团队成员', members.data?.members.filter(member => member.enabled).length]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value ?? '—'}</strong></div>)}</div><div className={styles.columns}><section><div className={styles.sectionHeading}><h2>共同推进的工作</h2>{canExecute && <Link className={styles.primary} to="/tasks/new">＋ 新建任务</Link>}</div><input className={styles.search} aria-label="搜索团队任务" placeholder="搜索团队任务…" value={search} onChange={event => setSearch(event.target.value)} />{tasks.isPending ? <p role="status">正在加载任务…</p> : tasks.isError ? <p role="alert">任务加载失败 <button onClick={() => void tasks.refetch()}>重试</button></p> : visibleTasks.length ? <div className={styles.taskList}>{visibleTasks.slice(0, 12).map(task => <button key={task.id} type="button" className={styles.taskRow} onClick={() => openTask(task.id)}><span className={styles.taskDot} data-status={task.status} /><span><strong>{task.title}</strong><small>{dateLabel(task.updatedAt)} 更新</small></span><span className={styles.badge}>{taskLabels[task.status]}</span></button>)}</div> : <div className={styles.empty}><h3>{search ? '没有匹配的任务' : '团队的第一个目标是什么？'}</h3><p>{search ? '试试其他关键词。' : '新建任务后，成员可以在这里查看进展、补充上下文并接续工作。'}</p></div>}<Link className={styles.textLink} to="/tasks">查看全部任务 <span aria-hidden="true">→</span></Link></section><aside className={styles.activity}><h2>最近活动</h2>{recentActivity.length ? recentActivity.map(event => <button type="button" key={`${event.taskId}:${event.id}`} onClick={() => openTask(event.taskId)}><small>{dateLabel(event.at)}</small><strong>{event.message}</strong><span>{event.title}</span></button>) : <p>任务推进后，最新动态会显示在这里。</p>}<div className={styles.sharingNote}><span aria-hidden="true">◈</span><strong>在同一个空间，同步向前</strong><p>当前空间的任务、会话与设备对团队成员可见。个人空间保持独立。</p><Link to="/devices">连接团队设备 →</Link></div></aside></div></> : <section className={styles.membersSection}><div className={styles.sectionHeading}><div><h2>一起工作的人</h2><p>按职责分配权限，让协作保持清晰。</p></div></div>{canManage && <form className={styles.inviteForm} onSubmit={event => void invite(event)}><label>账号用户名<input name="username" required maxLength={254} placeholder="输入对方已注册的用户名" /></label><label>邀请角色<select name="role" defaultValue="operator"><option value="operator">成员</option><option value="viewer">只读成员</option>{current.role === 'owner' && <option value="admin">管理员</option>}</select></label><button className={styles.primary} disabled={busy}>邀请成员</button><p>邀请显示在对方的协作空间页面，有效期 7 天，不发送邮件。</p></form>}{members.isPending ? <p role="status">正在加载成员…</p> : members.isError ? <p role="alert">成员加载失败 <button onClick={() => void members.refetch()}>重试</button></p> : <div className={styles.memberList}>{members.data?.members.map(member => {
          const canEdit = canManage && member.id !== identity.data?.user.id && (current.role === 'owner' || !['owner', 'admin'].includes(member.role));
          return <div className={styles.memberRow} key={member.id}><span className={styles.memberAvatar} aria-hidden="true">{member.displayName.slice(0, 1)}</span><span className={styles.memberIdentity}><strong>{member.displayName}{member.id === identity.data?.user.id ? '（你）' : ''}</strong><small>{member.username} {!member.enabled && '· 已停用'}</small></span>{canEdit ? <><select aria-label={`${member.displayName}的角色`} value={member.role} disabled={busy} onChange={event => action.mutate({ path: `/api/organization/members/${member.id}`, method: 'PATCH', body: { role: event.target.value as WorkspaceRole, expectedUpdatedAt: member.updatedAt } })}>{(current.role === 'owner' ? ['owner', 'admin', 'operator', 'viewer'] as const : ['operator', 'viewer'] as const).map(role => <option key={role} value={role}>{roleLabels[role]}</option>)}</select><button className={styles.secondary} disabled={busy} type="button" onClick={() => action.mutate({ path: `/api/organization/members/${member.id}`, method: 'PATCH', body: { enabled: !member.enabled, expectedUpdatedAt: member.updatedAt } })}>{member.enabled ? '停用' : '启用'}</button></> : <span className={styles.badge}>{roleLabels[member.role]}</span>}</div>;
        })}</div>}{Boolean(members.data?.invitations.length) && <section className={styles.pendingInvites}><h3>待接受邀请</h3>{members.data?.invitations.map(invite => <div key={invite.id}><span>{invite.username}<small>{roleLabels[invite.role]} · {dateLabel(new Date(invite.expiresAt).toISOString())} 到期</small></span>{(current.role === 'owner' || invite.role !== 'admin') && <button type="button" className={styles.secondary} disabled={busy} onClick={() => action.mutate({ path: `/api/workspaces/invitations/${invite.id}`, method: 'DELETE' })}>撤销邀请</button>}</div>)}</section>}<p className={styles.roleHelp}>成员可创建和执行任务；只读成员可查看共享内容。管理员负责配置和普通成员管理，所有者可管理全部角色。</p></section>}
      </>}
      <footer className={styles.footer}><span>◈ AgentFlow</span><span>每个人的想法，都能成为团队的下一步。</span></footer>
    </div>
  </section>;
}
