import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiRequest } from '../api/client.js';

type UserRole = 'owner' | 'admin' | 'operator' | 'viewer';
interface Member { id: string; username: string; displayName: string; role: UserRole; enabled: boolean }
interface AuditEvent { actorName: string; action: string; createdAt: string; target: string }
interface BootstrapDetail { user?: { role: UserRole } | null; permissions?: string[] }
interface MembersData { members: Member[]; audit: AuditEvent[] }

const labels: Record<UserRole, string> = { owner: '组织所有者', admin: '管理员', operator: '操作员', viewer: '只读成员' };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

async function loadMembers(): Promise<MembersData> {
  const [members, audit] = await Promise.all([
    apiRequest<{ members: Member[] }>('/api/organization/members'),
    apiRequest<{ events: AuditEvent[] }>('/api/organization/audit')
  ]);
  return { members: members.members, audit: audit.events };
}

export function MembersPanel() {
  const client = useQueryClient();
  const [identity, setIdentity] = useState<BootstrapDetail>({});
  const [status, setStatus] = useState('');
  const canManage = identity.permissions?.includes('members.manage') === true;
  const roles: UserRole[] = identity.user?.role === 'owner' ? ['owner', 'admin', 'operator', 'viewer'] : ['operator', 'viewer'];

  useEffect(() => {
    const handleBootstrap = (event: Event) => setIdentity((event as CustomEvent<BootstrapDetail>).detail || {});
    window.addEventListener('bugflow:bootstrap', handleBootstrap);
    return () => window.removeEventListener('bugflow:bootstrap', handleBootstrap);
  }, []);

  const query = useQuery({ queryKey: ['organization', 'members'], queryFn: loadMembers, enabled: canManage });
  const refresh = () => client.invalidateQueries({ queryKey: ['organization', 'members'] });
  const action = useMutation({
    retry: false,
    mutationFn: ({ path, method, body }: { path: string; method: string; body: unknown }) => apiRequest(path, { method, body: JSON.stringify(body) }),
    onSuccess: async () => { setStatus('操作已完成'); await refresh(); },
    onError: error => setStatus(messageOf(error))
  });

  if (!canManage) return <div className="config-band"><p>当前账号没有成员管理权限。</p></div>;
  const submitCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget;
    action.mutate({ path: '/api/organization/members', method: 'POST', body: Object.fromEntries(new FormData(form)) }, { onSuccess: () => form.reset() });
  };
  const submitMember = (event: React.FormEvent<HTMLFormElement>, id: string) => {
    event.preventDefault(); const body: Record<string, FormDataEntryValue | boolean> = Object.fromEntries(new FormData(event.currentTarget));
    delete body.newPassword; body.enabled = body.enabled === 'true';
    action.mutate({ path: `/api/organization/members/${id}`, method: 'PATCH', body });
  };
  const resetPassword = (form: HTMLFormElement, id: string) => {
    const input = form.elements.namedItem('newPassword') as HTMLInputElement;
    if (input.value.length < 12) {
      input.setCustomValidity('密码至少 12 位'); input.reportValidity(); input.setCustomValidity(''); return;
    }
    action.mutate({ path: `/api/organization/members/${id}/password`, method: 'PUT', body: { password: input.value } }, { onSuccess: () => { input.value = ''; setStatus('密码已重置'); } });
  };

  return <div className="config-band">
    <h2>组织成员</h2>
    <p>所有者管理全部成员；管理员只能管理操作员和只读成员。停用账号会立即撤销其登录会话。</p>
    <form id="memberForm" className="fields-grid" onSubmit={submitCreate}>
      <label>用户名<input name="username" required minLength={3} maxLength={80} autoComplete="off" /></label>
      <label>显示名称<input name="displayName" required maxLength={80} /></label>
      <label>初始密码<input name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label>
      <label>角色<select name="role" defaultValue="viewer">{roles.map(role => <option key={role} value={role}>{labels[role]}</option>)}</select></label>
      <button className="button primary" type="submit" disabled={action.isPending}>添加成员</button>
    </form>
    <p id="memberStatus" role="status">{query.isPending ? '正在读取成员…' : query.error ? messageOf(query.error) : status || `${query.data?.members.length || 0} 位成员`}</p>
    <div id="memberList" className="member-list">
      {query.data?.members.map(member => {
        const editable = identity.user?.role === 'owner' || ['operator', 'viewer'].includes(member.role);
        const memberRoles = roles.includes(member.role) ? roles : [member.role, ...roles];
        return <form className="member-card" key={member.id} onSubmit={event => submitMember(event, member.id)}>
        <strong>{member.username} · {labels[member.role]}</strong>
        <label>显示名称<input name="displayName" defaultValue={member.displayName} disabled={!editable} /></label>
        <label>角色<select name="role" defaultValue={member.role} disabled={!editable}>{memberRoles.map(role => <option key={role} value={role}>{labels[role]}</option>)}</select></label>
        <label>状态<select name="enabled" defaultValue={String(member.enabled)} disabled={!editable}><option value="true">启用</option><option value="false">停用</option></select></label>
        <button className="button secondary" disabled={action.isPending || !editable}>保存</button>
        <label>重置密码<input name="newPassword" type="password" minLength={12} maxLength={128} disabled={!editable} /></label>
        <button className="button ghost" type="button" disabled={action.isPending || !editable} onClick={event => resetPassword(event.currentTarget.form!, member.id)}>重置密码</button>
      </form>})}
    </div>
    <h3>角色权限</h3>
    <div className="table-scroll"><table className="role-table">
      <thead><tr><th>角色</th><th>查看数据</th><th>同步 / 分配 / 执行</th><th>审核 / 配置</th><th>成员管理</th></tr></thead>
      <tbody><tr><td>组织所有者</td><td>✓</td><td>✓</td><td>✓</td><td>全部角色</td></tr><tr><td>管理员</td><td>✓</td><td>✓</td><td>✓</td><td>操作员、只读成员</td></tr><tr><td>操作员</td><td>✓</td><td>✓</td><td>—</td><td>—</td></tr><tr><td>只读成员</td><td>✓</td><td>—</td><td>—</td><td>—</td></tr></tbody>
    </table></div>
    <h3>组织审计记录</h3>
    <button className="button secondary" type="button" onClick={refresh} disabled={query.isFetching}>刷新成员与记录</button>
    <div id="auditList" className="member-list">{query.data?.audit.map((item, index) => <div className="member-card" key={`${item.createdAt}-${index}`}><strong>{item.actorName} · {item.action}</strong><p>{item.createdAt} · {item.target}</p></div>)}</div>
  </div>;
}
