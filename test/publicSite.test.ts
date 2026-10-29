import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createStaticHandler } from '../src/http/staticAssets.js';

// Exercise real built files through the production static handler, without a database.
test('public HTML, documentation and discovery files are independently served with correct status and assets', async () => {
  const handler = createStaticHandler(path.resolve('.'));
  const server = http.createServer((req, res) => { void handler(req, res, new URL(req.url || '/', 'http://localhost')).catch(() => { res.writeHead(500); res.end(); }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const route of ['/', '/index.html', '/docs', '/docs/', '/docs/quickstart', '/docs/tasks', '/docs/devices', '/docs/jira', '/docs/sessions', '/docs/self-hosting', '/docs/api', '/docs/troubleshooting', '/docs/development/']) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      const html = await response.text();
      assert.match(html, /<h1>/);
      assert.match(html, /name="description"/);
      assert.match(html, /rel="canonical"/);
      assert.doesNotMatch(html, /react-entry/);
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(match => match[1]);
      assert.equal(assets.length, 2);
      for (const asset of assets) assert.equal((await fetch(base + asset)).status, 200, asset);
      const head = await fetch(base + route, { method: 'HEAD' });
      assert.equal(head.status, 200); assert.equal(await head.text(), '');
    }
    for (const route of ['/docs/nonexistent', '/docs/nested/missing', '/docs/%2e%2e%2f.env']) assert.equal((await fetch(base + route)).status, 404);
    assert.equal((await fetch(base + '/docs', { method: 'POST' })).status, 404);
    for (const query of ['?google_login=test-exchange-code', '?auth_error=cancelled']) {
      const response = await fetch(base + '/' + query);
      assert.match(await response.text(), /react-entry/);
    }
    assert.match(await (await fetch(base + '/tasks')).text(), /react-entry/);
    const sitemap = await fetch(base + '/sitemap.xml');
    assert.match(sitemap.headers.get('content-type') || '', /application\/xml/);
    assert.match(await sitemap.text(), /https:\/\/autoworkflow.top\/docs\/api/);
    assert.match(await (await fetch(base + '/robots.txt')).text(), /Disallow: \/api\//);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
