import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './src/database.js';
import { createTenantRuntime } from './src/tenantRuntime.js';
import { createAuthHandler } from './src/authHttp.js';
import { permissionForRoute, permissionsFor } from './src/rbac.js';
import { assertSeparateWorkspaces, canonicalWorkspace, databasePath, loadEnvironment, provisionDefaultTenant, tenantEnvironment } from './src/tenancy.js';
import type { ServerResponse } from 'node:http';
import type { Tenant } from './src/database.js';
import type { Environment } from './src/issueSources/types.js';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
type TenantRuntime = ReturnType<typeof createTenantRuntime>;
interface AppOptions { rootDir?: string; environment?: Environment }
type ErrorLike = Error & { statusCode?: number };
const asError = (value: unknown): ErrorLike => value instanceof Error ? value as ErrorLike : new Error(String(value));

export function createApp({ rootDir = projectDir, environment = loadEnvironment(rootDir) }: AppOptions = {}) {
  const filename = databasePath(rootDir, environment);
  const database = openDatabase(filename);
  const handleAuth = createAuthHandler(database);
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
      if (['/', '/index.html'].includes(url.pathname) && ['GET', 'HEAD'].includes(req.method || '')) {
        const template = await readFile(path.join(projectDir, 'public', 'index.html'), 'utf8');
        const content = template.replace('/__WEB_ENTRY__', `/${await webEntryAsset()}`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : content);
        return;
      }
      if (/^\/assets\/[A-Za-z0-9._-]+\.(?:js|css)$/.test(url.pathname) && ['GET', 'HEAD'].includes(req.method || '')) {
        let content: Buffer;
        try { content = await readFile(path.join(projectDir, 'public', 'build', url.pathname.slice(1))); }
        catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return sendJson(res, 404, { message: '资源不存在' });
          throw error;
        }
        const type = url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' });
        res.end(req.method === 'HEAD' ? undefined : content);
        return;
      }
      const assets: Record<string, [string, string]> = { '/app.js': ['build/app.js', 'text/javascript; charset=utf-8'], '/historyView.js': ['build/historyView.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
      assets['/taskContent.js'] = ['build/taskContent.js', 'text/javascript; charset=utf-8'];
      assets['/taskCenter.js'] = ['build/taskCenter.js', 'text/javascript; charset=utf-8'];
      assets['/agentRunConfig.js'] = ['build/agentRunConfig.js', 'text/javascript; charset=utf-8'];
      assets['/historyComposer.js'] = ['build/historyComposer.js', 'text/javascript; charset=utf-8'];
      assets['/historyTimeline.js'] = ['build/historyTimeline.js', 'text/javascript; charset=utf-8'];
      assets['/taskTimeline.js'] = ['build/taskTimeline.js', 'text/javascript; charset=utf-8'];
      const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : null;
      if (!asset || !['GET', 'HEAD'].includes(req.method || '')) return sendJson(res, 404, { message: '页面不存在' });
      const content = await readFile(path.join(projectDir, 'public', asset![0]!));
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (caught: unknown) {
      const error = asError(caught);
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

async function webEntryAsset() {
  const raw = await readFile(path.join(projectDir, 'public', 'build', '.vite', 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw) as Record<string, { file?: unknown; isEntry?: unknown }>;
  const entry = manifest['web/src/main.tsx'];
  if (!entry || entry.isEntry !== true || typeof entry.file !== 'string' || !/^assets\/[A-Za-z0-9._-]+\.js$/.test(entry.file)) {
    throw new Error('Web 构建清单缺少有效入口，请先运行 pnpm build:client');
  }
  return entry.file;
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
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
