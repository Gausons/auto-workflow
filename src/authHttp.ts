// @ts-nocheck
import { ROLES, httpError, permissionsFor, publicIdentity } from './rbac.js';

export function createAuthHandler(database) {
  const attempts = new Map();
  let passwordOperations = 0;
  function rateLimit(key, limit = 10) {
    const now = Date.now();
    for (const [entry, value] of attempts) if (value.until <= now) attempts.delete(entry);
    const value = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
    if (value.count >= limit || (!attempts.has(key) && attempts.size >= 10000)) throw httpError(429, '尝试次数过多，请 15 分钟后重试');
    value.count += 1;
    attempts.set(key, value);
  }
  async function expensive(operation) {
    if (passwordOperations >= 4) throw httpError(429, '正在处理其他登录请求，请稍后重试');
    passwordOperations += 1;
    try { return await operation(); } finally { passwordOperations -= 1; }
  }
  const sessionResponse = (session) => ({ ...session, ...publicIdentity(database.authenticateSession(session.token)) });

  return async function handleAuth(req, res, url, token, principal, sendJson) {
    const endpoint = url.pathname;
    if (endpoint === '/api/auth/login' && req.method === 'POST') {
      rateLimit(`ip:${req.socket.remoteAddress}`, 100);
      const body = await readAuthJson(req);
      const key = `login:${String(body.tenantId).slice(0, 64)}:${String(body.username).trim().toLowerCase().slice(0, 80)}`;
      rateLimit(key);
      const session = await expensive(() => database.login(body.tenantId, body.username, body.password));
      attempts.delete(key);
      sendJson(res, 200, sessionResponse(session));
      return true;
    }
    if (endpoint === '/api/auth/setup' && ['GET', 'POST'].includes(req.method)) {
      const tenant = database.authenticate(token);
      if (!tenant) throw httpError(401, '请提供有效的组织初始化令牌');
      if (database.hasUsers(tenant.id)) throw httpError(409, '组织已初始化，组织令牌已停用，请使用成员账号登录');
      if (req.method === 'GET') { sendJson(res, 200, { tenant, setupRequired: true }); return true; }
      rateLimit(`setup:${req.socket.remoteAddress}`, 20);
      const body = await readAuthJson(req);
      await expensive(() => database.createUser(tenant.id, body, { bootstrap: true, authorizeBootstrap: () => {
        if (database.authenticate(token)?.id !== tenant.id) throw httpError(401, '组织初始化令牌已失效');
      } }));
      // Setup deliberately returns no long-lived organization authority. The new owner logs in as a member.
      sendJson(res, 201, { tenant, message: '组织所有者已创建，请使用用户名和密码登录' });
      return true;
    }
    if (!principal) return false;
    if (endpoint === '/api/auth/session' && req.method === 'GET') {
      sendJson(res, 200, publicIdentity(principal)); return true;
    }
    if (endpoint === '/api/auth/logout' && req.method === 'POST') {
      database.logout(token);
      database.audit(principal.tenant.id, principal.user, 'auth.logout');
      sendJson(res, 200, { ok: true }); return true;
    }
    if (endpoint === '/api/auth/password' && req.method === 'PUT') {
      rateLimit(`password:${principal.user.id}`);
      const body = await readAuthJson(req);
      await expensive(() => database.changePassword(principal, body));
      sendJson(res, 200, { ok: true, message: '密码已修改，请重新登录' }); return true;
    }
    if (endpoint === '/api/organization/audit' && req.method === 'GET') {
      requirePermission(principal, 'audit.read');
      sendJson(res, 200, { events: database.listAudit(principal.tenant.id) }); return true;
    }
    if (endpoint === '/api/organization/roles' && req.method === 'GET') {
      requirePermission(principal, 'members.manage');
      sendJson(res, 200, { roles: Object.entries(ROLES).map(([id, role]) => ({ id, ...role })) }); return true;
    }
    if (endpoint === '/api/organization/members' && ['GET', 'POST'].includes(req.method)) {
      requirePermission(principal, 'members.manage');
      if (req.method === 'GET') sendJson(res, 200, { members: database.listUsers(principal.tenant.id) });
      else {
        const input = await readAuthJson(req);
        const user = await expensive(() => database.createUser(principal.tenant.id, input, { actor: principal.user }));
        sendJson(res, 201, { user });
      }
      return true;
    }
    const member = endpoint.match(/^\/api\/organization\/members\/([a-zA-Z0-9-]+)(\/password)?$/);
    if (member && ((req.method === 'PATCH' && !member[2]) || (req.method === 'PUT' && member[2]))) {
      requirePermission(principal, 'members.manage');
      const input = await readAuthJson(req);
      if (member[2]) {
        await expensive(() => database.resetPassword(principal.tenant.id, member[1], input.password, principal.user));
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 200, { user: database.updateUser(principal.tenant.id, member[1], input, principal.user) });
      }
      return true;
    }
    return false;
  };
}

function requirePermission(principal, permission) {
  if (!permissionsFor(principal.user.role).includes(permission)) throw httpError(403, '当前角色没有此操作权限');
}

export async function readAuthJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw httpError(413, '请求体过大');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw httpError(400, '请求体必须为 JSON 对象'); }
}
