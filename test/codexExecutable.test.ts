import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodexExecutable } from '../src/codexExecutable.js';

test('desktop binary is found with the minimal PATH used by GUI-launched servers', () => {
  const binary = '/Applications/ChatGPT.app/Contents/Resources/codex';
  assert.equal(resolveCodexExecutable({ environment: { PATH: '/usr/bin:/bin' }, platform: 'darwin', usable: file => file === binary }), binary);
});
test('explicit executable wins without silently falling back to another installation', () => {
  assert.equal(resolveCodexExecutable({ environment: { CODEX_EXECUTABLE: '/custom/missing-codex' }, usable: () => false }), '/custom/missing-codex');
  assert.equal(resolveCodexExecutable({ executable: '/explicit/codex', environment: { CODEX_EXECUTABLE: '/other/codex' } }), '/explicit/codex');
});
test('PATH installation wins, user-installed app is supported, and non-mac hosts avoid mac paths', () => {
  assert.equal(resolveCodexExecutable({ environment: { PATH: '/tools:/usr/bin' }, platform: 'darwin', usable: () => true }), '/tools/codex');
  assert.equal(resolveCodexExecutable({ environment: { PATH: '/usr/bin', HOME: '/Users/test' }, platform: 'darwin', usable: f => f === '/Users/test/Applications/Codex.app/Contents/Resources/codex' }), '/Users/test/Applications/Codex.app/Contents/Resources/codex');
  assert.equal(resolveCodexExecutable({ environment: {}, platform: 'linux', usable: () => true }), 'codex');
});
