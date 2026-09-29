import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('history rendering uses the classes owned by the history layout', async () => {
  const app = await readFile(new URL('../web/src/history/HistoryPage.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  for (const className of ['history-card', 'history-chat-header', 'history-chat-content']) {
    assert.match(app, new RegExp(`className=["\\'][^"\\']*${className}`));
    assert.match(css, new RegExp(`\\.${className}(?:[\\s:{.>]|$)`));
  }
  assert.doesNotMatch(app, /className=["'][^"']*history-item/);
  assert.doesNotMatch(app, /className=["'][^"']*history-detail-heading/);
});

test('history list constrains long session titles to its grid column', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(css, /\.history-browser\s*\{[^}]*min-width:\s*0;/s);
  assert.match(css, /\.history-card strong\s*\{[^}]*text-overflow:\s*ellipsis;/s);
  assert.match(css, /\.history-card strong\s*\{[^}]*white-space:\s*nowrap;/s);
});

test('context continuation shares the new-task composer layout without clipping menus', async () => {
  const composer = await readFile(new URL('../web/src/history/HistoryComposer.tsx', import.meta.url), 'utf8');
  const modelMenu = await readFile(new URL('../web/src/tasks/ModelEffortMenu.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(composer, /className="conversation-switch tc-create-shell"/);
  assert.match(composer, /className="history-compose-footer"/);
  assert.match(composer, /className="conversation-new-controls"/);
  assert.match(composer, /<ModelEffortMenu /);
  assert.match(modelMenu, /className="tc-config-menu tc-model-menu"/);
  assert.match(composer, /branchBusy/);
  assert.match(css, /\.history-composer\s*\{[^}]*overflow:\s*visible;/s);
  assert.doesNotMatch(css, /\.conversation-new-actions\s*\{/);
});
