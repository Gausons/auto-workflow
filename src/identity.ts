import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ROLES, httpError } from './rbac.js';

type Role = keyof typeof ROLES;
interface PublicUser {
  id: string;
  tenantId: string;
  username: string;
  displayName: string;
  role: Role;
  enabled: number;
  createdAt: string;
  updatedAt: string;
}
interface StoredUser extends PublicUser { password_hash: string }
interface Actor { id: string; username?: string }
interface UserInput { username?: unknown; displayName?: unknown; role?: unknown; password?: unknown }
interface UserUpdate { role?: unknown; enabled?: unknown; displayName?: unknown }
interface CreateUserOptions { actor?: Actor | null; bootstrap?: boolean; authorizeBootstrap?: () => void }
interface Principal { tenant: { id: string; name?: string }; user: PublicUser; expiresAt?: number }
interface PasswordChange { currentPassword?: unknown; password?: unknown }
type Transaction = <T>(operation: () => T) => T;

const derive = (password: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, 64, scryptOptions, (error, key) => error ? reject(error) : resolve(key));
});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PUBLIC_COLUMNS = 'id, tenant_id AS tenantId, username, display_name AS displayName, role, enabled, created_at AS createdAt, updated_at AS updatedAt';
export const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

export async function hashPassword(password: unknown) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw httpError(400, '密码长度必须为 12–128 个字符');
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

async function verifyPassword(password: unknown, encoded: unknown) {
  // Also perform password derivation for unknown usernames to avoid a fast enumeration path.
  const fallback = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;
  const [, salt, expected] = (typeof encoded === 'string' ? encoded : fallback).split('$');
  const key = await derive(typeof password === 'string' ? password : '', salt);
  return timingSafeEqual(key, Buffer.from(expected, 'hex')) && typeof encoded === 'string';
}

export function createIdentityStore(db: DatabaseSync, transaction: Transaction) {
  const getUser = (tenantId: string, id: string) => db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM organization_users WHERE tenant_id = ? AND id = ?`).get(tenantId, id) as unknown as PublicUser | undefined;
  const listUsers = (tenantId: string) => db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM organization_users WHERE tenant_id = ? ORDER BY created_at, id`).all(tenantId) as unknown as PublicUser[];
  const hasUsers = (tenantId: string) => Boolean(db.prepare('SELECT 1 FROM organization_users WHERE tenant_id = ? LIMIT 1').get(tenantId));

  function audit(tenantId: string, actor: Actor | null | undefined, action: string, target = '', detail: unknown = {}) {
    db.prepare('INSERT INTO audit_events(tenant_id, actor_id, actor_name, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(tenantId, actor?.id || null, actor?.username || 'system', action, target, JSON.stringify(detail), new Date().toISOString());
  }
  function liveActor(tenantId: string, actor: Actor | null | undefined) {
    const current = actor && getUser(tenantId, actor.id);
    if (!current?.enabled || !['owner', 'admin'].includes(current.role)) throw httpError(403, '没有成员管理权限');
    return current;
  }
  function validateRole(role: unknown): asserts role is Role {
    if (typeof role !== 'string' || !Object.hasOwn(ROLES, role)) throw httpError(400, '无效的成员角色');
  }
  function guardTarget(actor: PublicUser, target: PublicUser | null, nextRole: Role) {
    if (actor.role === 'admin' && ((target && ['owner', 'admin'].includes(target.role)) || ['owner', 'admin'].includes(nextRole))) {
      throw httpError(403, '管理员只能管理操作员和只读成员；所有者可管理管理员');
    }
  }
  async function createUser(tenantId: string, input: UserInput, { actor, bootstrap = false, authorizeBootstrap = () => {} }: CreateUserOptions = {}): Promise<PublicUser> {
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    if (!/^[a-z0-9][a-z0-9._@-]{2,79}$/.test(username)) throw httpError(400, '用户名需为 3–80 位字母、数字、点、下划线、短横线或 @');
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : username;
    if (!displayName || displayName.length > 80) throw httpError(400, '显示名称需为 1–80 个字符');
    const requestedRole = bootstrap ? 'owner' : input.role ?? 'viewer';
    validateRole(requestedRole);
    const role = requestedRole;
    if (bootstrap ? hasUsers(tenantId) : false) throw httpError(409, '组织已初始化，请使用成员账号登录');
    if (!bootstrap) guardTarget(liveActor(tenantId, actor), null, role);
    const passwordHash = await hashPassword(input.password);
    return transaction(() => {
      if (bootstrap) authorizeBootstrap();
      // Re-check after the asynchronous password hash; role changes and competing setup requests must not race.
      if (bootstrap && hasUsers(tenantId)) throw httpError(409, '组织已初始化，请使用成员账号登录');
      const current = bootstrap ? null : liveActor(tenantId, actor);
      if (current) guardTarget(current, null, role);
      if (db.prepare('SELECT 1 FROM organization_users WHERE tenant_id = ? AND username = ?').get(tenantId, username)) throw httpError(409, '该组织内的用户名已存在');
      const id = randomUUID(), now = new Date().toISOString();
      db.prepare('INSERT INTO organization_users VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)').run(id, tenantId, username, displayName, passwordHash, role, now, now);
      audit(tenantId, current || { id, username }, bootstrap ? 'organization.initialized' : 'member.created', id, { role });
      const created = getUser(tenantId, id);
      if (!created) throw new Error('成员创建后无法读取');
      return created;
    });
  }
  function updateUser(tenantId: string, id: string, input: UserUpdate, actor: Actor): PublicUser {
    return transaction(() => {
      const current = liveActor(tenantId, actor), target = getUser(tenantId, id);
      if (!target) throw httpError(404, '成员不存在');
      const requestedRole = input.role ?? target.role;
      validateRole(requestedRole);
      const role = requestedRole;
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw httpError(400, 'enabled 必须为布尔值');
      const enabled = input.enabled === undefined ? target.enabled : Number(input.enabled);
      const name = input.displayName === undefined ? target.displayName : String(input.displayName).trim();
      if (!name || name.length > 80) throw httpError(400, '显示名称需为 1–80 个字符');
      guardTarget(current, target, role);
      if (target.role === 'owner' && target.enabled && (role !== 'owner' || !enabled)) {
        const count = (db.prepare("SELECT count(*) AS count FROM organization_users WHERE tenant_id = ? AND role = 'owner' AND enabled = 1").get(tenantId) as unknown as { count: number }).count;
        if (count <= 1) throw httpError(409, '组织必须保留至少一位启用的所有者');
      }
      db.prepare('UPDATE organization_users SET role = ?, enabled = ?, display_name = ?, updated_at = ? WHERE tenant_id = ? AND id = ?')
        .run(role, enabled, name, new Date().toISOString(), tenantId, id);
      if (!enabled) revokeUserSessions(tenantId, id);
      audit(tenantId, current, 'member.updated', id, { previousRole: target.role, role, enabled: Boolean(enabled) });
      const updated = getUser(tenantId, id);
      if (!updated) throw new Error('成员更新后无法读取');
      return updated;
    });
  }
  const revokeUserSessions = (tenantId: string, id: string) => db.prepare('DELETE FROM user_sessions WHERE tenant_id = ? AND user_id = ?').run(tenantId, id);

  async function resetPassword(tenantId: string, id: string, password: unknown, actor: Actor) {
    const current = liveActor(tenantId, actor), target = getUser(tenantId, id);
    if (!target) throw httpError(404, '成员不存在');
    guardTarget(current, target, target.role);
    const passwordHash = await hashPassword(password);
    transaction(() => {
      const currentActor = liveActor(tenantId, actor), currentTarget = getUser(tenantId, id);
      if (!currentTarget) throw httpError(404, '成员不存在');
      guardTarget(currentActor, currentTarget, currentTarget.role);
      db.prepare('UPDATE organization_users SET password_hash = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(passwordHash, new Date().toISOString(), tenantId, id);
      revokeUserSessions(tenantId, id);
      audit(tenantId, currentActor, 'member.password_reset', id);
    });
  }
  function issueSession(tenantId: string, userId: string) {
    const token = randomBytes(32).toString('base64url'), expiresAt = Date.now() + SESSION_DURATION_MS;
    db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(Date.now());
    db.prepare('INSERT INTO user_sessions VALUES (?, ?, ?, ?, ?)').run(digest(token), tenantId, userId, expiresAt, new Date().toISOString());
    return { token, expiresAt };
  }
  async function login(tenantId: unknown, username: unknown, password: unknown) {
    if (typeof tenantId !== 'string' || typeof username !== 'string' || typeof password !== 'string' || password.length > 128 || username.length > 80 || tenantId.length > 63) throw httpError(401, '组织、用户名或密码不正确');
    const row = db.prepare('SELECT * FROM organization_users WHERE tenant_id = ? AND username = ?').get(tenantId, username.trim().toLowerCase()) as unknown as StoredUser | undefined;
    const valid = await verifyPassword(password, row?.password_hash);
    // A reset or disable while the hash runs must invalidate this login too.
    const fresh = row && db.prepare('SELECT * FROM organization_users WHERE tenant_id = ? AND id = ?').get(tenantId, row.id) as unknown as StoredUser | undefined;
    if (!row || !valid || !fresh?.enabled || fresh.password_hash !== row.password_hash) throw httpError(401, '组织、用户名或密码不正确');
    const session = issueSession(tenantId, row.id);
    audit(tenantId, getUser(tenantId, row.id), 'auth.login');
    return session;
  }
  function authenticateSession(token: unknown) {
    if (typeof token !== 'string' || token.length > 512) return null;
    const row = db.prepare('SELECT tenant_id, user_id, expires_at FROM user_sessions WHERE token_hash = ? AND expires_at > ?').get(digest(token), Date.now()) as unknown as { tenant_id: string; user_id: string; expires_at: number } | undefined;
    if (!row) return null;
    const user = getUser(row.tenant_id, row.user_id);
    if (!user?.enabled) return null;
    const tenant = db.prepare('SELECT id, name FROM tenants WHERE id = ?').get(row.tenant_id) as unknown as { id: string; name: string } | undefined;
    if (!tenant) return null;
    return { tenant, user, expiresAt: row.expires_at };
  }
  async function changePassword(principal: Principal, input: PasswordChange) {
    const row = db.prepare('SELECT password_hash FROM organization_users WHERE tenant_id = ? AND id = ?').get(principal.tenant.id, principal.user.id) as unknown as { password_hash: string } | undefined;
    if (typeof input.currentPassword !== 'string' || input.currentPassword.length > 128 || !await verifyPassword(input.currentPassword, row?.password_hash)) throw httpError(400, '当前密码不正确');
    if (!row) throw httpError(400, '当前密码不正确');
    const nextHash = await hashPassword(input.password);
    transaction(() => {
      const fresh = db.prepare('SELECT password_hash, enabled FROM organization_users WHERE tenant_id = ? AND id = ?').get(principal.tenant.id, principal.user.id) as unknown as { password_hash: string; enabled: number } | undefined;
      if (!fresh?.enabled || fresh.password_hash !== row.password_hash) throw httpError(409, '账号状态已变化，请重新登录');
      db.prepare('UPDATE organization_users SET password_hash = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(nextHash, new Date().toISOString(), principal.tenant.id, principal.user.id);
      revokeUserSessions(principal.tenant.id, principal.user.id);
      audit(principal.tenant.id, principal.user, 'auth.password_changed');
    });
  }
  return {
    hasUsers, createUser, getUser, listUsers, updateUser, resetPassword, login, authenticateSession, changePassword, audit,
    logout: (token: string) => db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(digest(token)),
    listAudit: (tenantId: string) => (db.prepare('SELECT id, actor_name AS actorName, action, target, detail, created_at AS createdAt FROM audit_events WHERE tenant_id = ? ORDER BY id DESC LIMIT 200').all(tenantId) as unknown as Array<{ id: number; actorName: string; action: string; target: string; detail: string; createdAt: string }>).map(row => ({ ...row, detail: JSON.parse(row.detail) as unknown }))
  };
}
