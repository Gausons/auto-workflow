import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './src/database.js';
import { createTenantRuntime } from './src/tenantRuntime.js';
import { createRealtime } from './src/realtime.js';
import { createAuthHandler } from './src/authHttp.js';
import { createStaticHandler } from './src/http/staticAssets.js';
import { sendJson } from './src/http/response.js';
import { permissionForRoute, permissionsFor } from './src/rbac.js';
import { assertSeparateWorkspaces, canonicalWorkspace, loadEnvironment, provisionDefaultTenant, tenantEnvironment } from './src/tenancy.js';
import type { Tenant } from './src/database.js';
import type { Environment } from './src/issueSources/types.js';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
type TenantRuntime = ReturnType<typeof createTenantRuntime>;
interface AppOptions { rootDir?: string; environment?: Environment; fetchImpl?: typeof fetch }
type ErrorLike = Error & { statusCode?: number };
const asError = (value: unknown): ErrorLike => value instanceof Error ? value as ErrorLike : new Error(String(value));

export function createApp({ rootDir = projectDir, environment = loadEnvironment(rootDir), fetchImpl }: AppOptions = {}) {
  const database = openDatabase(environment);
  const handleAuth = createAuthHandler(database, { environment, fetchImpl });
  const serveWeb = createStaticHandler(projectDir);
  const runtimes = new Map<string, TenantRuntime>();
  const environments = new Map<string, Environment>();
  let closing = false;

  function tenantEnv(tenant: Tenant) {
    if (!environments.has(tenant.id)) environments.set(tenant.id, tenantEnvironment(tenant, rootDir, environment));
    return environments.get(tenant.id)!;
  }
  function workspaceFor(tenant: Tenant): string {
    if (runtimes.has(tenant.id)) return runtimes.get(tenant.id)!.workspace();
    const configured = tenantEnv(tenant).CODEX_WORKSPACE_DIR || (tenant.id === 'default' ? database.readSettings(tenant.id).config.codexWorkspaceDir : '');
    return typeof configured === 'string' && configured ? configured : tenant.id === 'default' ? rootDir : '';
  }
  function validateWorkspace(tenant: Tenant, workspace: unknown) {
    const candidate = typeof workspace === 'string' ? workspace : '';
    const configured = tenantEnv(tenant).CODEX_WORKSPACE_DIR;
    if (database.listTenants().length > 1 && canonicalWorkspace(candidate || rootDir) !== canonicalWorkspace(workspaceFor(tenant) || rootDir)) {
      throw Object.assign(new Error('多租户模式下请管理员通过租户环境文件修改 IDE 工作目录，并重启服务'), { statusCode: 400 });
    }
    if (configured && canonicalWorkspace(candidate || rootDir) !== canonicalWorkspace(configured)) {
      throw Object.assign(new Error('IDE 工作目录已由租户环境文件固定'), { statusCode: 400 });
    }
    assertSeparateWorkspaces(database.listTenants().map((item) => ({ id: item.id, workspace: item.id === tenant.id ? candidate : workspaceFor(item) })));
  }
  function runtimeFor(tenant: Tenant) {
    if (!runtimes.has(tenant.id)) {
      validateWorkspace(tenant, workspaceFor(tenant));
      runtimes.set(tenant.id, createTenantRuntime({ database, tenant, environment: tenantEnv(tenant), rootDir, validateWorkspace: workspace => validateWorkspace(tenant, workspace) }));
    }
    return runtimes.get(tenant.id)!;
  }

  try {
    provisionDefaultTenant(database, rootDir, environment);
    database.importLegacy(rootDir, 'default');
    assertSeparateWorkspaces(database.listTenants().map((tenant) => ({ id: tenant.id, workspace: workspaceFor(tenant) })));
  } catch (error: unknown) { database.close(); throw error; }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (closing) return sendJson(res, 503, { message: '服务正在关闭' });
      if (url.pathname.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'GET' && url.pathname === '/api/health') {
          try { database.ping(); return sendJson(res, 200, { status: 'ok' }); }
          catch { return sendJson(res, 503, { status: 'unavailable' }); }
        }
        const authorization = req.headers.authorization || '';
        const token = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
        const principal = database.authenticateSession(token);
        if (principal && req.headers['x-tenant-id'] && req.headers['x-tenant-id'] !== principal.tenant.id) {
          return sendJson(res, 403, { error: 'tenant_mismatch', message: '登录会话不属于指定账号空间' });
        }
        if (await handleAuth(req, res, url, token, principal, sendJson)) return;
        if (!principal) return sendJson(res, 401, { error: 'unauthorized', message: '请登录个人账号' });
        const { tenant, user } = principal;
        const permission = permissionForRoute(req.method, url.pathname);
        if (!permission) return sendJson(res, 404, { error: 'not_found', message: '接口不存在' });
        if (!permissionsFor(user.role).includes(permission)) {
          database.audit(tenant.id, user, 'access.denied', url.pathname, { method: req.method });
          return sendJson(res, 403, { error: 'forbidden', message: '当前角色没有此操作权限' });
        }
        if (req.method !== 'GET') res.once('finish', () => database.audit(tenant.id, user, 'api.request', url.pathname, { method: req.method, status: res.statusCode }));
        await runtimeFor(tenant).handleApi(req, res, url, principal);
        return;
      }
      await serveWeb(req, res, url);
    } catch (caught: unknown) {
      const error = asError(caught);
      if (!res.headersSent) sendJson(res, error.statusCode || 500, { error: 'request_failed', message: error.message || '服务端错误' });
      else res.destroy();
    }
  });

  const realtime = createRealtime(server, database, runtimeFor);
  return {
    server,
    async close() {
      closing = true;
      await realtime.close();
      for (const runtime of runtimes.values()) runtime.closeStreams();
      const stopped = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      await stopped;
      try { await Promise.all([...runtimes.values()].map((runtime) => runtime.close())); }
      finally { database.close(); }
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const environment = loadEnvironment(projectDir);
  const app = createApp({ environment });
  const port = Number(environment.PORT || 4173);
  const host = environment.HOST || '127.0.0.1';
  app.server.on('error', (error) => { console.error(error.message); process.exit(1); });
  app.server.listen(port, host, () => {
    const address = app.server.address();
    console.log(`Auto bug workflow workbench: http://${host}:${typeof address === 'object' && address ? address.port : port}`);
    console.log('Database: PostgreSQL + pgvector');
    console.log('首次使用请在登录页注册个人账号，也可以配置 Google 登录。');
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    app.close().then(() => process.exit(0), (error) => { console.error(error.message); process.exit(1); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
