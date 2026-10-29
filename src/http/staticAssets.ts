import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './response.js';

export function createStaticHandler(projectDir: string) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const publicPath = publicSiteFile(url);
    if (publicPath && ['GET', 'HEAD'].includes(req.method || '')) {
      let content: Buffer;
      try { content = await readFile(path.join(projectDir, 'public', 'build', 'site', publicPath)); }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return sendJson(res, 404, { message: '文档不存在' });
        throw error;
      }
      const type = publicPath.endsWith('.xml') ? 'application/xml; charset=utf-8' : publicPath.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
      return;
    }
    if (isWebPagePath(url.pathname) && ['GET', 'HEAD'].includes(req.method || '')) {
      const template = await readFile(path.join(projectDir, 'public', 'index.html'), 'utf8');
      const assets = await webEntryAssets(projectDir);
      const content = template.replace('/__WEB_ENTRY__', `/${assets.script}`).replace('<!--__WEB_STYLES__-->', assets.styles.map(file => `<link rel="stylesheet" href="/${file}" />`).join('\n    '));
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
    if (url.pathname !== '/styles.css' || !['GET', 'HEAD'].includes(req.method || '')) return sendJson(res, 404, { message: '页面不存在' });
    const content = await readFile(path.join(projectDir, 'public', 'styles.css'));
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  };
}

function publicSiteFile(url: URL): string | null {
  if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') return url.pathname.slice(1);
  // Google callbacks still render the original login flow at its existing URL.
  if ((url.pathname === '/' || url.pathname === '/index.html') && !url.searchParams.has('auth_error') && !url.searchParams.has('google_login')) return 'index.html';
  if (/^\/docs(?:\/[a-z0-9-]+)?\/?$/.test(url.pathname)) return `${url.pathname.slice(1).replace(/\/$/, '')}/index.html`;
  if (url.pathname.startsWith('/docs/')) return 'missing/index.html';
  return null;
}

function isWebPagePath(value: string) {
  if (value === '/' || value === '/index.html') return true;
  return /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\/?$/.test(value) && value !== '/api' && !value.startsWith('/api/') && value !== '/assets' && !value.startsWith('/assets/');
}

async function webEntryAssets(projectDir: string) {
  const raw = await readFile(path.join(projectDir, 'public', 'build', '.vite', 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw) as Record<string, { file?: unknown; isEntry?: unknown; css?: unknown }>;
  const entry = manifest['web/src/main.tsx'];
  if (!entry || entry.isEntry !== true || typeof entry.file !== 'string' || !/^assets\/[A-Za-z0-9._-]+\.js$/.test(entry.file)) {
    throw new Error('Web 构建清单缺少有效入口，请先运行 pnpm build:client');
  }
  if (entry.css !== undefined && (!Array.isArray(entry.css) || !entry.css.every(file => typeof file === 'string' && /^assets\/[A-Za-z0-9._-]+\.css$/.test(file)))) {
    throw new Error('Web 构建清单包含无效样式资源');
  }
  return { script: entry.file, styles: (entry.css || []) as string[] };
}
