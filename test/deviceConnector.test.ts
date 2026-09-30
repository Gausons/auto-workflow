import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { deviceConnectorDefaults, deviceStateDirectory, resolveDeviceStateDirectory } from '../scripts/device-sync.js';

test('device connector defaults to the user home with execution and excerpts enabled', () => {
  assert.deepEqual(deviceConnectorDefaults({}), {
    execute: true,
    includeExcerpts: true,
    workspace: homedir()
  });
  assert.deepEqual(deviceConnectorDefaults({
    CODEX_WORKSPACE_DIR: '/work',
    WORKBENCH_EXECUTE_CODEX: 'false',
    WORKBENCH_SYNC_EXCERPTS: 'false'
  }), {
    execute: false,
    includeExcerpts: false,
    workspace: '/work'
  });
});

test('default device state is stable per server and account and isolated across connections', () => {
  const first = { origin: 'https://one.example.com', tenantId: 'team', userId: 'owner' };
  const same = deviceStateDirectory({}, first);
  assert.equal(deviceStateDirectory({}, first), same);
  assert.notEqual(deviceStateDirectory({}, { ...first, origin: 'https://two.example.com' }), same);
  assert.notEqual(deviceStateDirectory({}, { ...first, userId: 'other' }), same);
  assert.match(same, new RegExp(`^${path.resolve('.workflow-data', 'devices').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${path.sep}`));
  assert.equal(deviceStateDirectory({ WORKBENCH_DEVICE_DIR: './custom-device' }, first), path.resolve('./custom-device'));
});

test('matching legacy state is preserved while another server receives an isolated directory', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'device-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = { origin: 'https://one.example.com', tenantId: 'team', userId: 'owner' };
  const legacy = path.join(root, '.workflow-data', 'device');
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, 'connection.json'), JSON.stringify(first));
  assert.equal(await resolveDeviceStateDirectory({}, first, root), legacy);
  assert.equal(await resolveDeviceStateDirectory({}, { ...first, origin: 'https://two.example.com' }, root), deviceStateDirectory({}, { ...first, origin: 'https://two.example.com' }, root));
});
