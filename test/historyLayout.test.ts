import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('history rendering uses the classes owned by the history layout', async () => {
  const app = await readFile(new URL('../public/app.ts', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  for (const className of ['history-card', 'history-chat-header', 'history-chat-content']) {
    assert.match(app, new RegExp(`class=["\\'][^"\\']*${className}`));
    assert.match(css, new RegExp(`\\.${className}(?:[\\s:{.>]|$)`));
  }
  assert.doesNotMatch(app, /class=["'][^"']*history-item/);
  assert.doesNotMatch(app, /class=["'][^"']*history-detail-heading/);
});

test('history list constrains long session titles to its grid column', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(css, /\.history-browser\s*\{[^}]*min-width:\s*0;/s);
  assert.match(css, /\.history-card strong\s*\{[^}]*text-overflow:\s*ellipsis;/s);
  assert.match(css, /\.history-card strong\s*\{[^}]*white-space:\s*nowrap;/s);
});
