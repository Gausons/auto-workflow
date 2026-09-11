import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './src/database.js';
import { createTenantRuntime } from './src/tenantRuntime.js';
import { createAuthHandler } from './src/authHttp.js';
import { permissionForRoute, permissionsFor } from './src/rbac.js';
import { assertSeparateWorkspaces, canonicalWorkspace, databasePath, loadEnvironment, provisionDefaultTenant, tenantEnvironment } from './src/tenancy.js';

const projectDir = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ rootDir = projectDir, environment = loadEnvironment(rootDir) }: any = {}) {
  const filename = databasePath(rootDir, environment);
  const database = openDatabase(filename);
  const handleAuth = createAuthHandler(database);
  const runtimes = new Map();
  const environments = new Map();
  let closing = false;

  function tenantEnv(tenant: any) {
    if (!environments.has(tenant.id)) environments.set(tenant.id, tenantEnvironment(tenant, rootDir, environment));
    return environments.get(tenant.id);
  }
  function workspaceFor(tenant: any) {
    if (runtimes.has(tenant.id)) return runtimes.get(tenant.id).workspace();
    return tenantEnv(tenant).CODEX_WORKSPACE_DIR || (tenant.id === 'default' ? database.readSettings(tenant.id).config.codexWorkspaceDir || rootDir : '');
  }
  function validateWorkspace(tenant: any, workspace: any) {
    const configured = tenantEnv(tenant).CODEX_WORKSPACE_DIR;
    if (database.listTenants().length > 1 && canonicalWorkspace(workspace || rootDir) !== canonicalWorkspace(workspaceFor(tenant) || rootDir)) {
      throw Object.assign(new Error('多租户模式下请管理员通过租户环境文件修改 IDE 工作目录，并重启服务'), { statusCode: 400 });
    }
    if (configured && canonicalWorkspace(workspace || rootDir) !== canonicalWorkspace(configured)) {
      throw Object.assign(new Error('IDE 工作目录已由租户环境文件固定'), { statusCode: 400 });
    }
    assertSeparateWorkspaces(database.listTenants().map((item) => ({ id: item.id, workspace: item.id === tenant.id ? workspace : workspaceFor(item) })));
  }
  function runtimeFor(tenant: any) {
    if (!runtimes.has(tenant.id)) {
      validateWorkspace(tenant, workspaceFor(tenant));
      runtimes.set(tenant.id, createTenantRuntime({ database, tenant, environment: tenantEnv(tenant), rootDir, validateWorkspace: (workspace: any) => validateWorkspace(tenant, workspace) }));
    }
    return runtimes.get(tenant.id);
  }

  try {
    provisionDefaultTenant(database, rootDir, environment);
    database.importLegacy(rootDir, 'default');
    assertSeparateWorkspaces(database.listTenants().map((tenant) => ({ id: tenant.id, workspace: workspaceFor(tenant) })));
  } catch (error: any) { database.close(); throw error; }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (closing) return sendJson(res, 503, { message: '服务正在关闭' });
      if (url.pathname.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        const authorization = req.headers.authorization || '';
        const token = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
        const principal = database.authenticateSession(token);
        if (principal && req.headers['x-tenant-id'] && req.headers['x-tenant-id'] !== principal.tenant.id) {
          return sendJson(res, 403, { error: 'tenant_mismatch', message: '登录会话不属于指定组织' });
        }
        if (await handleAuth(req, res, url, token, principal, sendJson)) return;
        if (!principal) return sendJson(res, 401, { error: 'unauthorized', message: '请使用组织成员账号登录；首次使用请先初始化组织所有者' });
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
      const assets: any = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['build/app.js', 'text/javascript; charset=utf-8'], '/historyView.js': ['build/historyView.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
      assets['/taskCenter.js'] = ['build/taskCenter.js', 'text/javascript; charset=utf-8'];
      const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : null;
      if (!asset || !['GET', 'HEAD'].includes(req.method || '')) return sendJson(res, 404, { message: '页面不存在' });
      const content = await readFile(path.join(projectDir, 'public', asset![0]!));
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error: any) {
      if (!res.headersSent) sendJson(res, error.statusCode || 500, { error: 'request_failed', message: error.message || '服务端错误' });
      else res.destroy();
    }
  });

  return {
    server,
    filename,
    async close() {
      closing = true;
      const stopped = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      await stopped;
      try { await Promise.all([...runtimes.values()].map((runtime) => runtime.close())); }
      finally { database.close(); }
    }
  };
}

function sendJson(res: any, status: any, data: any) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
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
    console.log(`Database: ${app.filename}`);
    console.log(`首次初始化组织所有者：使用 DEFAULT_TENANT_TOKEN 或 ${path.join(path.dirname(app.filename), 'default-token')}；初始化后使用成员账号登录。`);
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
