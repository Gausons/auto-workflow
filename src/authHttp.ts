import { ROLES, httpError, permissionsFor, publicIdentity } from './rbac.js';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Environment } from './issueSources/types.js';

type Database = ReturnType<typeof import('./database.js').openDatabase>;
type Principal = NonNullable<ReturnType<Database['authenticateSession']>>;
type SendJson = (response: ServerResponse, status: number, value: unknown) => void;

interface AuthOptions { environment?: Environment; fetchImpl?: typeof fetch }

export function createAuthHandler(database: Database, { environment = {}, fetchImpl = fetch }: AuthOptions = {}) {
  const attempts = new Map<string, { count: number; until: number }>();
  const googleExchanges = new Map<string, { session: { token: string; expiresAt: number }; expiresAt: number }>();
  const googleStates = new Map<string, { expiresAt: number }>();
  let passwordOperations = 0;
  function rateLimit(key: string, limit = 10) {
    const now = Date.now();
    for (const [entry, value] of attempts) if (value.until <= now) attempts.delete(entry);
    const value = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
    if (value.count >= limit || (!attempts.has(key) && attempts.size >= 10000)) throw httpError(429, '尝试次数过多，请 15 分钟后重试');
    value.count += 1;
    attempts.set(key, value);
  }
  async function expensive<T>(operation: () => Promise<T>): Promise<T> {
    if (passwordOperations >= 4) throw httpError(429, '正在处理其他登录请求，请稍后重试');
    passwordOperations += 1;
    try { return await operation(); } finally { passwordOperations -= 1; }
  }
  const sessionResponse = (session: { token: string; expiresAt: number }) => {
    const principal = database.authenticateSession(session.token);
    if (!principal) throw httpError(401, '登录会话创建失败');
    return { ...session, ...publicIdentity(principal) };
  };
  const googleConfigured = () => Boolean(environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET);
  const googleRedirectUri = (req: IncomingMessage) => {
    if (environment.GOOGLE_REDIRECT_URI) {
      const configured = new URL(environment.GOOGLE_REDIRECT_URI);
      const local = ['localhost', '127.0.0.1', '::1'].includes(configured.hostname);
      if (!['http:', 'https:'].includes(configured.protocol) || (configured.protocol !== 'https:' && !local)) throw httpError(500, 'GOOGLE_REDIRECT_URI 必须使用 HTTPS；本机 localhost 可使用 HTTP');
      return configured.toString();
    }
    const host = req.headers.host || '';
    if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host)) throw httpError(500, '请配置 GOOGLE_REDIRECT_URI');
    const encrypted = 'encrypted' in req.socket && Boolean(req.socket.encrypted);
    return `${encrypted ? 'https' : 'http'}://${host}/api/auth/google/callback`;
  };
  const oauthCookie = (value: string, secure: boolean, clear = false) => `bugflow.oauthState=${value}; Path=/api/auth/google; HttpOnly; SameSite=Lax; ${secure ? 'Secure; ' : ''}${clear ? 'Max-Age=0; ' : 'Max-Age=600; '}`;
  const cookieValue = (req: IncomingMessage, name: string) => (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) || '';
  const redirectAuth = (res: ServerResponse, query: string, clearCookie?: string) => {
    if (clearCookie) res.setHeader('Set-Cookie', clearCookie);
    res.writeHead(303, { Location: `/?${query}` });
    res.end();
  };
  const beginGoogle = (req: IncomingMessage) => {
    if (!googleConfigured()) throw httpError(503, 'Google 登录尚未配置');
    const redirectUri = googleRedirectUri(req);
    const state = randomBytes(32).toString('base64url');
    const now = Date.now();
    for (const [key, value] of googleStates) if (value.expiresAt <= now) googleStates.delete(key);
    if (googleStates.size >= 10000) throw httpError(429, 'Google 登录请求过多，请稍后重试');
    googleStates.set(state, { expiresAt: now + 10 * 60_000 });
    const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorization.search = new URLSearchParams({ client_id: environment.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri,
      response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' }).toString();
    return { authorization: authorization.toString(), cookie: oauthCookie(state, redirectUri.startsWith('https:')) };
  };

  return async function handleAuth(req: IncomingMessage, res: ServerResponse, url: URL, token: unknown, principal: Principal | null, sendJson: SendJson) {
    const endpoint = url.pathname;
    if (endpoint === '/api/auth/providers' && req.method === 'GET') {
      sendJson(res, 200, { google: googleConfigured() });
      return true;
    }
    if (endpoint === '/api/auth/register' && req.method === 'POST') {
      rateLimit(`register:${req.socket.remoteAddress}`, 10);
      const body = await readAuthJson(req);
      const session = await expensive(() => database.registerPersonal(body));
      sendJson(res, 201, sessionResponse(session));
      return true;
    }
    if (endpoint === '/api/auth/login' && req.method === 'POST') {
      rateLimit(`ip:${req.socket.remoteAddress}`, 100);
      const body = await readAuthJson(req);
      const key = `login:${String(body.username).trim().toLowerCase().slice(0, 80)}`;
      rateLimit(key);
      const session = await expensive(() => typeof body.tenantId === 'string'
        ? database.login(body.tenantId, body.username, body.password)
        : database.loginPersonal(body.username, body.password));
      attempts.delete(key);
      sendJson(res, 200, sessionResponse(session));
      return true;
    }
    if (endpoint === '/api/auth/google/start' && req.method === 'GET') {
      if (!googleConfigured()) {
        redirectAuth(res, `auth_error=${encodeURIComponent('Google 单点登录尚未配置，请先设置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET')}`);
        return true;
      }
      rateLimit(`google:${req.socket.remoteAddress}`, 100);
      const flow = beginGoogle(req);
      res.setHeader('Set-Cookie', flow.cookie);
      res.writeHead(302, { Location: flow.authorization });
      res.end();
      return true;
    }
    if (endpoint === '/api/auth/google/callback' && req.method === 'GET') {
      const redirectUri = googleRedirectUri(req);
      const clearCookie = oauthCookie('', redirectUri.startsWith('https:'), true);
      try {
        if (!googleConfigured()) throw httpError(503, 'Google 登录尚未配置');
        const state = url.searchParams.get('state') || '';
        const flow = googleStates.get(state);
        googleStates.delete(state);
        if (!state || state !== cookieValue(req, 'bugflow.oauthState') || !flow || flow.expiresAt <= Date.now()) throw httpError(400, 'Google 登录状态已失效，请重试');
        if (url.searchParams.get('error')) throw httpError(401, 'Google 登录已取消');
        const code = url.searchParams.get('code');
        if (!code || code.length > 4096) throw httpError(400, 'Google 登录返回无效');
        const tokenResponse = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15000),
          body: new URLSearchParams({ code, client_id: environment.GOOGLE_CLIENT_ID!, client_secret: environment.GOOGLE_CLIENT_SECRET!, redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
        const tokenData = await tokenResponse.json().catch(() => ({})) as Record<string, unknown>;
        if (!tokenResponse.ok || typeof tokenData.access_token !== 'string') throw httpError(502, '无法完成 Google 登录');
        const profileResponse = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }, signal: AbortSignal.timeout(15000) });
        const profile = await profileResponse.json().catch(() => ({})) as Record<string, unknown>;
        if (!profileResponse.ok || typeof profile.sub !== 'string' || profile.sub.length > 255 || typeof profile.email !== 'string' || profile.email_verified !== true) {
          throw httpError(401, 'Google 账号邮箱未验证');
        }
        const googleProfile = { subject: profile.sub, email: profile.email,
          displayName: typeof profile.name === 'string' ? profile.name.slice(0, 80) : profile.email };
        const session = database.loginWithGoogle(googleProfile);
        const exchange = randomBytes(32).toString('base64url');
        const now = Date.now();
        for (const [key, value] of googleExchanges) if (value.expiresAt <= now) googleExchanges.delete(key);
        if (googleExchanges.size >= 10000) throw httpError(429, 'Google 登录请求过多，请稍后重试');
        googleExchanges.set(exchange, { session, expiresAt: now + 60_000 });
        redirectAuth(res, `google_login=${encodeURIComponent(exchange)}`, clearCookie);
      } catch (caught: unknown) {
        const message = caught instanceof Error ? caught.message : 'Google 登录失败';
        redirectAuth(res, `auth_error=${encodeURIComponent(message)}`, clearCookie);
      }
      return true;
    }
    if (endpoint === '/api/auth/google/exchange' && req.method === 'POST') {
      const body = await readAuthJson(req);
      const code = typeof body.code === 'string' ? body.code : '';
      const exchange = googleExchanges.get(code);
      googleExchanges.delete(code);
      if (!exchange || exchange.expiresAt <= Date.now()) throw httpError(401, 'Google 登录结果已失效，请重试');
      sendJson(res, 200, sessionResponse(exchange.session));
      return true;
    }
    if (endpoint === '/api/auth/setup' && ['GET', 'POST'].includes(req.method || '')) {
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
      if (typeof token === 'string') database.logout(token);
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
    if (endpoint === '/api/organization/members' && ['GET', 'POST'].includes(req.method || '')) {
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

function requirePermission(principal: Principal, permission: string) {
  if (!permissionsFor(principal.user.role).includes(permission)) throw httpError(403, '当前角色没有此操作权限');
}

export async function readAuthJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw httpError(413, '请求体过大');
    chunks.push(buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw httpError(400, '请求体必须为 JSON 对象'); }
}
