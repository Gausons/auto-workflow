import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('primary navigation keeps four work tabs and moves administration into settings', async () => {
  const app = await readFile(new URL('../web/src/app/App.tsx', import.meta.url), 'utf8');
  const primaryNavigation = app.match(/<nav className="nav-list"[\s\S]*?<\/nav>/)?.[0] || '';

  assert.equal((primaryNavigation.match(/<Link/g) || []).length, 4);
  for (const route of ['/tasks/new', '/tasks', '/workbench', '/history']) {
    assert.match(primaryNavigation, new RegExp(`to="${route.replaceAll('/', '\\/')}"`));
  }
  assert.doesNotMatch(primaryNavigation, /to="\/settings/);
  assert.match(app, /className="page settings-page"/);
  for (const panel of ['assignment', 'config', 'members', 'account']) {
    assert.ok(app.includes(`['${panel}'`));
  }
  assert.match(app, /path: 'settings\/:section'/);
});
