import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('primary navigation keeps four work tabs and moves administration into settings', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.ts', import.meta.url), 'utf8');
  const primaryNavigation = html.match(/<nav class="nav-list"[\s\S]*?<\/nav>/)?.[0] || '';

  assert.equal((primaryNavigation.match(/data-nav=/g) || []).length, 4);
  for (const route of ['new-task', 'tasks', 'workbench', 'history']) {
    assert.match(primaryNavigation, new RegExp(`data-nav="${route}"`));
  }
  assert.doesNotMatch(primaryNavigation, /data-nav="(?:assignment|config|members|account)"/);
  assert.match(html, /data-page="settings"/);
  for (const panel of ['assignment', 'config', 'members', 'account']) {
    assert.match(html, new RegExp(`data-settings-panel="${panel}"`));
  }
  assert.match(app, /view\.startsWith\('settings\/'\)/);
});
