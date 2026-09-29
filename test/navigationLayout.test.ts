import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('primary navigation keeps five work tabs and personal settings', async () => {
  const app = await readFile(new URL('../web/src/app/App.tsx', import.meta.url), 'utf8');
  const primaryNavigation = app.match(/<nav className="nav-list"[\s\S]*?<\/nav>/)?.[0] || '';

  assert.equal((primaryNavigation.match(/<Link/g) || []).length, 5);
  for (const route of ['/tasks/new', '/tasks', '/workbench', '/history', '/devices']) {
    assert.match(primaryNavigation, new RegExp(`to="${route.replaceAll('/', '\\/')}"`));
  }
  assert.doesNotMatch(primaryNavigation, /to="\/settings/);
  assert.match(app, /className="page settings-page"/);
  for (const panel of ['assignment', 'config', 'account']) {
    assert.ok(app.includes(`['${panel}'`));
  }
  assert.doesNotMatch(app, /组织成员/);
  assert.match(app, /path: 'settings\/:section'/);
});
