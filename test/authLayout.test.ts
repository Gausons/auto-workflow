import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('authentication and workspace views cannot render at the same time', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  assert.match(css, /\.login-screen\s*\{[^}]*display:\s*grid;/s);
  assert.match(css, /\.login-card\s*\{/);
  assert.match(html, /id="workspaceShell"\s+hidden/);
  assert.match(html, /id="loginScreen"/);
});
