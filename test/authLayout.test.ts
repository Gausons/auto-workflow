import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';

test('login page and its entire JavaScript import graph are served without authentication', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'bugflow-login-assets-'));
  const app = createApp({ rootDir, environment: { DEFAULT_TENANT_TOKEN: 'login-assets-test-token'.repeat(2) } });
  try {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const html = await page.text();
    const pending = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(match => new URL(match[1], base).href);
    assert.ok(pending.length > 0);
    const visited = new Set<string>();
    while (pending.length) {
      const url = pending.pop()!;
      if (visited.has(url)) continue;
      visited.add(url);
      const response = await fetch(url);
      assert.equal(response.status, 200, `Unable to load ${url}`);
      assert.match(response.headers.get('content-type') || '', /javascript/);
      const source = await response.text();
      for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g)) {
        pending.push(new URL(match[1], url).href);
      }
    }
  } finally {
    await app.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('authentication and workspace views cannot render at the same time', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  assert.match(css, /\.login-screen\s*\{[^}]*display:\s*grid;/s);
  assert.match(css, /\.login-card\s*\{/);
  assert.match(html, /id="workspaceShell"\s+hidden/);
  assert.match(html, /id="loginScreen"/);
});
