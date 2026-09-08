import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ROLES, httpError } from './rbac.mjs';

const derive = promisify(scrypt);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PUBLIC_COLUMNS = 'id, tenant_id AS tenantId, username, display_name AS displayName, role, enabled, created_at AS createdAt, updated_at AS updatedAt';
export const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw httpError(400, '密码长度必须为 12–128 个字符');
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, scryptOptions);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  // Also perform password derivation for unknown usernames to avoid a fast enumeration path.
  const [, salt, expected] = (encoded || `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`).split('$');
  const key = await derive(typeof password === 'string' ? password : '', salt, 64, scryptOptions);
  return timingSafeEqual(key, Buffer.from(expected, 'hex')) && Boolean(encoded);
}

export function createIdentityStore(db, transaction) {
  const getUser = (tenantId, id) => db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM organization_users WHERE tenant_id = ? AND id = ?`).get(tenantId, id);
  const listUsers = (tenantId) => db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM organization_users WHERE tenant_id = ? ORDER BY created_at, id`).all(tenantId);
  const hasUsers = (tenantId) => Boolean(db.prepare('SELECT 1 FROM organization_users WHERE tenant_id = ? LIMIT 1').get(tenantId));

  function audit(tenantId, actor, action, target = '', detail = {}) {
    db.prepare('INSERT INTO audit_events(tenant_id, actor_id, actor_name, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(tenantId, actor?.id || null, actor?.username || 'system', action, target, JSON.stringify(detail), new Date().toISOString());
  }
  function liveActor(tenantId, actor) {
    const current = actor && getUser(tenantId, actor.id);
    if (!current?.enabled || !['owner', 'admin'].includes(current.role)) throw httpError(403, '没有成员管理权限');
    return current;
  }
  function validateRole(role) {
    if (!Object.hasOwn(ROLES, role)) throw httpError(400, '无效的成员角色');
  }
  function guardTarget(actor, target, nextRole) {
    if (actor.role === 'admin' && (['owner', 'admin'].includes(target?.role) || ['owner', 'admin'].includes(nextRole))) {
      throw httpError(403, '管理员只能管理操作员和只读成员；所有者可管理管理员');
    }
  }
  async function createUser(tenantId, input, { actor, bootstrap = false, authorizeBootstrap = () => {} } = {}) {
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    if (!/^[a-z0-9][a-z0-9._@-]{2,79}$/.test(username)) throw httpError(400, '用户名需为 3–80 位字母、数字、点、下划线、短横线或 @');
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : username;
    if (!displayName || displayName.length > 80) throw httpError(400, '显示名称需为 1–80 个字符');
    const role = bootstrap ? 'owner' : input.role || 'viewer';
    validateRole(role);
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
      return getUser(tenantId, id);
    });
  }
  function updateUser(tenantId, id, input, actor) {
    return transaction(() => {
      const current = liveActor(tenantId, actor), target = getUser(tenantId, id);
      if (!target) throw httpError(404, '成员不存在');
      const role = input.role ?? target.role;
      validateRole(role);
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw httpError(400, 'enabled 必须为布尔值');
      const enabled = input.enabled === undefined ? target.enabled : Number(input.enabled);
      const name = input.displayName === undefined ? target.displayName : String(input.displayName).trim();
      if (!name || name.length > 80) throw httpError(400, '显示名称需为 1–80 个字符');
      guardTarget(current, target, role);
      if (target.role === 'owner' && target.enabled && (role !== 'owner' || !enabled)) {
        const count = db.prepare("SELECT count(*) AS count FROM organization_users WHERE tenant_id = ? AND role = 'owner' AND enabled = 1").get(tenantId).count;
        if (count <= 1) throw httpError(409, '组织必须保留至少一位启用的所有者');
      }
      db.prepare('UPDATE organization_users SET role = ?, enabled = ?, display_name = ?, updated_at = ? WHERE tenant_id = ? AND id = ?')
        .run(role, enabled, name, new Date().toISOString(), tenantId, id);
      if (!enabled) revokeUserSessions(tenantId, id);
      audit(tenantId, current, 'member.updated', id, { previousRole: target.role, role, enabled: Boolean(enabled) });
      return getUser(tenantId, id);
    });
  }
  const revokeUserSessions = (tenantId, id) => db.prepare('DELETE FROM user_sessions WHERE tenant_id = ? AND user_id = ?').run(tenantId, id);

  async function resetPassword(tenantId, id, password, actor) {
    const current = liveActor(tenantId, actor), target = getUser(tenantId, id);
    if (!target) throw httpError(404, '成员不存在');
    guardTarget(current, target, target.role);
    const passwordHash = await hashPassword(password);
    transaction(() => {
      const currentActor = liveActor(tenantId, actor), currentTarget = getUser(tenantId, id);
      guardTarget(currentActor, currentTarget, currentTarget.role);
      db.prepare('UPDATE organization_users SET password_hash = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(passwordHash, new Date().toISOString(), tenantId, id);
      revokeUserSessions(tenantId, id);
      audit(tenantId, currentActor, 'member.password_reset', id);
    });
  }
  function issueSession(tenantId, userId) {
    const token = randomBytes(32).toString('base64url'), expiresAt = Date.now() + SESSION_DURATION_MS;
    db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(Date.now());
    db.prepare('INSERT INTO user_sessions VALUES (?, ?, ?, ?, ?)').run(digest(token), tenantId, userId, expiresAt, new Date().toISOString());
    return { token, expiresAt };
  }
  async function login(tenantId, username, password) {
    if (typeof tenantId !== 'string' || typeof username !== 'string' || typeof password !== 'string' || password.length > 128 || username.length > 80 || tenantId.length > 63) throw httpError(401, '组织、用户名或密码不正确');
    const row = db.prepare('SELECT * FROM organization_users WHERE tenant_id = ? AND username = ?').get(tenantId, username.trim().toLowerCase());
    const valid = await verifyPassword(password, row?.password_hash);
    // A reset or disable while the hash runs must invalidate this login too.
    const fresh = row && db.prepare('SELECT * FROM organization_users WHERE tenant_id = ? AND id = ?').get(tenantId, row.id);
    if (!valid || !fresh?.enabled || fresh.password_hash !== row.password_hash) throw httpError(401, '组织、用户名或密码不正确');
    const session = issueSession(tenantId, row.id);
    audit(tenantId, getUser(tenantId, row.id), 'auth.login');
    return session;
  }
  function authenticateSession(token) {
    if (typeof token !== 'string' || token.length > 512) return null;
    const row = db.prepare('SELECT tenant_id, user_id, expires_at FROM user_sessions WHERE token_hash = ? AND expires_at > ?').get(digest(token), Date.now());
    if (!row) return null;
    const user = getUser(row.tenant_id, row.user_id);
    if (!user?.enabled) return null;
    const tenant = db.prepare('SELECT id, name FROM tenants WHERE id = ?').get(row.tenant_id);
    return { tenant, user, expiresAt: row.expires_at };
  }
  async function changePassword(principal, input) {
    const row = db.prepare('SELECT password_hash FROM organization_users WHERE tenant_id = ? AND id = ?').get(principal.tenant.id, principal.user.id);
    if (typeof input.currentPassword !== 'string' || input.currentPassword.length > 128 || !await verifyPassword(input.currentPassword, row.password_hash)) throw httpError(400, '当前密码不正确');
    const nextHash = await hashPassword(input.password);
    transaction(() => {
      const fresh = db.prepare('SELECT password_hash, enabled FROM organization_users WHERE tenant_id = ? AND id = ?').get(principal.tenant.id, principal.user.id);
      if (!fresh?.enabled || fresh.password_hash !== row.password_hash) throw httpError(409, '账号状态已变化，请重新登录');
      db.prepare('UPDATE organization_users SET password_hash = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(nextHash, new Date().toISOString(), principal.tenant.id, principal.user.id);
      revokeUserSessions(principal.tenant.id, principal.user.id);
      audit(principal.tenant.id, principal.user, 'auth.password_changed');
    });
  }
  return {
    hasUsers, createUser, getUser, listUsers, updateUser, resetPassword, login, authenticateSession, changePassword, audit,
    logout: (token) => db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(digest(token)),
    listAudit: (tenantId) => db.prepare('SELECT id, actor_name AS actorName, action, target, detail, created_at AS createdAt FROM audit_events WHERE tenant_id = ? ORDER BY id DESC LIMIT 200').all(tenantId).map((row) => ({ ...row, detail: JSON.parse(row.detail) }))
  };
}
