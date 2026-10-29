import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { Connection } from './storage/connection.js';
import { httpError } from './rbac.js';

interface User { id: string; tenantId: string; username: string; displayName: string; role: string; enabled: number }
interface Principal { user: User; tenant: { id: string }; scope?: string; token?: unknown }
interface Dependencies {
  authenticateSession(token: unknown): Principal | null;
  transaction<T>(operation: () => T): T;
  getUser(tenantId: string, id: string): User | undefined;
  issueSession(tenantId: string, userId: string): { token: string; expiresAt: number };
  audit(tenantId: string, actor: User, action: string, target?: string, detail?: unknown): void;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function createWorkspaceStore(db: Connection, { transaction, getUser, issueSession, audit, authenticateSession }: Dependencies) {
  // Account identity is resolved through explicit membership, never by matching a display name or email.
  function account(principal: Principal): User {
    if ('token' in principal) {
      const live = authenticateSession(principal.token);
      if (!live || live.user.id !== principal.user.id || live.tenant.id !== principal.tenant.id) throw httpError(401, '登录会话已失效，请重新登录');
    }
    if (principal.scope === 'connector') throw httpError(403, '设备会话不能管理协作空间');
    const origin = db.prepare('SELECT account_id AS id FROM workspace_memberships WHERE member_id = ?').get(principal.user.id);
    const row = db.prepare('SELECT id, tenant_id AS tenantId FROM organization_users WHERE id = ? AND enabled = 1').get(String(origin?.id || principal.user.id));
    const current = getUser(principal.tenant.id, principal.user.id);
    if (!row || !current?.enabled) throw httpError(401, '账号已停用');
    return getUser(String(row.tenantId), String(row.id))!;
  }
  function lockTeam(principal: Principal, manage = false) {
    account(principal);
    db.prepare('SELECT id FROM tenants WHERE id = ? FOR UPDATE').get(principal.tenant.id);
    if (!db.prepare('SELECT tenant_id FROM team_workspaces WHERE tenant_id = ? FOR UPDATE').get(principal.tenant.id)) throw httpError(400, '请先进入团队空间');
    const user = getUser(principal.tenant.id, principal.user.id)!;
    if (manage && !['owner', 'admin'].includes(user.role)) throw httpError(403, '当前角色没有成员管理权限');
    return user;
  }
  function addMember(tenantId: string, owner: User, role: string) {
    const existing = db.prepare('SELECT member_id FROM workspace_memberships WHERE tenant_id = ? AND account_id = ?').get(tenantId, owner.id);
    if (existing) {
      const current = getUser(tenantId, String(existing.member_id));
      if (current?.enabled) return String(existing.member_id);
      db.prepare('UPDATE organization_users SET role = ?, enabled = 1, updated_at = ? WHERE id = ? AND tenant_id = ?').run(role, new Date().toISOString(), existing.member_id, tenantId);
      return String(existing.member_id);
    }
    const id = randomUUID(), now = new Date().toISOString();
    db.prepare('INSERT INTO organization_users VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)').run(id, tenantId, owner.username, owner.displayName, `external$${randomBytes(32).toString('hex')}`, role, now, now);
    db.prepare('INSERT INTO workspace_memberships VALUES (?, ?, ?)').run(owner.id, tenantId, id);
    return id;
  }
  function workspaces(principal: Principal) {
    const owner = account(principal);
    const personal = db.prepare('SELECT id, name FROM tenants WHERE id = ?').get(owner.tenantId)!;
    const teams = db.prepare('SELECT t.id, t.name, u.role FROM workspace_memberships m JOIN tenants t ON t.id = m.tenant_id JOIN organization_users u ON u.id = m.member_id WHERE m.account_id = ? AND u.enabled = 1 ORDER BY t.created_at, t.id').all(owner.id);
    const invitations = db.prepare("SELECT i.id, t.name, i.role, i.expires_at AS expiresAt FROM workspace_invitations i JOIN tenants t ON t.id = i.tenant_id WHERE i.account_id = ? AND i.status = 'pending' AND i.expires_at > ? ORDER BY i.created_at DESC").all(owner.id, Date.now());
    return { currentId: principal.tenant.id, workspaces: [{ id: String(personal.id), name: String(personal.name), role: owner.role, kind: 'personal' }, ...teams.map(team => ({ id: String(team.id), name: String(team.name), role: String(team.role), kind: 'team' }))], invitations };
  }
  function createWorkspace(principal: Principal, input: Record<string, unknown>) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80) throw httpError(400, '空间名称需为 1–80 个字符');
    if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(input.requestId)) throw httpError(400, '请提供有效的请求标识');
    return transaction(() => {
      const owner = account(principal);
      db.prepare('SELECT id FROM organization_users WHERE id = ? FOR UPDATE').get(owner.id);
      const existing = db.prepare('SELECT w.tenant_id, t.name FROM team_workspaces w JOIN tenants t ON t.id = w.tenant_id WHERE w.creator_id = ? AND w.request_id = ?').get(owner.id, String(input.requestId));
      if (existing) {
        if (existing.name !== name) throw httpError(409, '此请求标识已用于另一空间名称，请重新创建');
        return { id: String(existing.tenant_id) };
      }
      const count = db.prepare('SELECT count(*) AS count FROM team_workspaces WHERE creator_id = ?').get(owner.id);
      if (Number(count?.count) >= 20) throw httpError(409, '每个账号最多创建 20 个团队空间');
      const id = `team-${randomUUID()}`;
      db.prepare('INSERT INTO tenants VALUES (?, ?, ?, ?)').run(id, name, digest(randomBytes(32).toString('hex')), new Date().toISOString());
      db.prepare('INSERT INTO tenant_settings(tenant_id) VALUES (?)').run(id);
      db.prepare('INSERT INTO team_workspaces VALUES (?, ?, ?)').run(id, owner.id, String(input.requestId));
      const memberId = addMember(id, owner, 'owner');
      audit(id, getUser(id, memberId)!, 'workspace.created', id);
      return { id };
    });
  }
  function switchWorkspace(principal: Principal, input: Record<string, unknown>) {
    return transaction(() => {
      const owner = account(principal);
      const tenantId = typeof input.tenantId === 'string' ? input.tenantId : '';
      let userId = owner.id;
      if (tenantId !== owner.tenantId) {
        const membership = db.prepare('SELECT member_id FROM workspace_memberships WHERE account_id = ? AND tenant_id = ?').get(owner.id, tenantId);
        if (!membership || !getUser(tenantId, String(membership.member_id))?.enabled) throw httpError(403, '你不是该空间的有效成员');
        userId = String(membership.member_id);
      }
      audit(tenantId, getUser(tenantId, userId)!, 'workspace.switched', tenantId);
      return issueSession(tenantId, userId);
    });
  }
  function workspaceMembers(principal: Principal) {
    const user = lockTeam(principal);
    const members = db.prepare('SELECT u.id, u.username, u.display_name AS displayName, u.role, u.enabled, u.updated_at AS updatedAt FROM workspace_memberships m JOIN organization_users u ON u.id = m.member_id WHERE m.tenant_id = ? ORDER BY u.created_at, u.id').all(principal.tenant.id);
    const invitations = ['owner', 'admin'].includes(user.role) ? db.prepare("SELECT i.id, u.username, i.role, i.expires_at AS expiresAt FROM workspace_invitations i JOIN organization_users u ON u.id = i.account_id WHERE i.tenant_id = ? AND i.status = 'pending' AND i.expires_at > ? ORDER BY i.created_at DESC").all(principal.tenant.id, Date.now()) : [];
    return { members, invitations };
  }
  function inviteWorkspaceMember(principal: Principal, input: Record<string, unknown>) {
    return transaction(() => {
      const user = lockTeam(principal, true);
      const role = input.role ?? 'operator';
      if (typeof role !== 'string' || !['admin', 'operator', 'viewer'].includes(role)) throw httpError(400, '无效的邀请角色');
      if (role === 'admin' && user.role !== 'owner') throw httpError(403, '只有所有者能邀请管理员');
      const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
      if (!username || username.length > 254) throw httpError(400, '请输入有效的账号用户名');
      const candidates = db.prepare('SELECT u.id, u.tenant_id AS tenantId FROM organization_users u WHERE u.username = ? AND u.enabled = 1 AND NOT EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.member_id = u.id)').all(username);
      if (candidates.length !== 1) throw httpError(400, '请填写已注册的唯一账号用户名');
      const target = candidates[0];
      const member = db.prepare('SELECT member_id FROM workspace_memberships WHERE tenant_id = ? AND account_id = ?').get(principal.tenant.id, target.id);
      if (member && getUser(principal.tenant.id, String(member.member_id))?.enabled) throw httpError(409, '该账号已是空间成员');
      const existing = db.prepare("SELECT id, role FROM workspace_invitations WHERE tenant_id = ? AND account_id = ? AND status = 'pending' AND expires_at > ?").get(principal.tenant.id, target.id, Date.now());
      if (existing) {
        if (existing.role !== role) throw httpError(409, '已有不同角色的邀请，请先撤销后重新邀请');
        return { id: String(existing.id) };
      }
      const id = randomUUID();
      db.prepare("INSERT INTO workspace_invitations VALUES (?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (tenant_id, account_id) DO UPDATE SET id = EXCLUDED.id, role = EXCLUDED.role, status = 'pending', created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at").run(id, principal.tenant.id, target.id, String(role), new Date().toISOString(), Date.now() + 7 * 86400000);
      audit(principal.tenant.id, user, 'workspace.invited', id, { role });
      return { id };
    });
  }
  function acceptWorkspaceInvitation(principal: Principal, id: string) {
    return transaction(() => {
      const owner = account(principal);
      const target = db.prepare('SELECT tenant_id FROM workspace_invitations WHERE id = ? AND account_id = ?').get(id, owner.id);
      if (!target) throw httpError(404, '邀请不存在');
      db.prepare('SELECT id FROM tenants WHERE id = ? FOR UPDATE').get(target.tenant_id);
      const invite = db.prepare('SELECT * FROM workspace_invitations WHERE id = ? AND account_id = ? FOR UPDATE').get(id, owner.id);
      if (!invite) throw httpError(404, '邀请不存在');
      if (invite.status === 'accepted') {
        const membership = db.prepare('SELECT member_id FROM workspace_memberships WHERE tenant_id = ? AND account_id = ?').get(invite.tenant_id, owner.id);
        if (!membership || !getUser(String(invite.tenant_id), String(membership.member_id))?.enabled) throw httpError(409, '成员已停用，请重新申请邀请');
        return { id: String(invite.tenant_id) };
      }
      if (invite.status !== 'pending' || Number(invite.expires_at) <= Date.now()) throw httpError(409, '邀请已撤销或过期');
      const memberId = addMember(String(invite.tenant_id), owner, String(invite.role));
      db.prepare("UPDATE workspace_invitations SET status = 'accepted' WHERE id = ?").run(id);
      audit(String(invite.tenant_id), getUser(String(invite.tenant_id), memberId)!, 'workspace.joined', id);
      return { id: String(invite.tenant_id) };
    });
  }
  function cancelWorkspaceInvitation(principal: Principal, id: string) {
    return transaction(() => {
      const user = lockTeam(principal, true);
      const invitation = db.prepare('SELECT role FROM workspace_invitations WHERE id = ? AND tenant_id = ? FOR UPDATE').get(id, principal.tenant.id);
      if (!invitation) throw httpError(404, '邀请不存在');
      if (user.role !== 'owner' && invitation.role === 'admin') throw httpError(403, '只有所有者能管理管理员邀请');
      db.prepare("UPDATE workspace_invitations SET status = 'cancelled' WHERE id = ? AND tenant_id = ? AND status = 'pending'").run(id, principal.tenant.id);
      audit(principal.tenant.id, user, 'workspace.invitation_cancelled', id);
      return { ok: true };
    });
  }
  return { workspaces, createWorkspace, switchWorkspace, workspaceMembers, inviteWorkspaceMember, acceptWorkspaceInvitation, cancelWorkspaceInvitation };
}
