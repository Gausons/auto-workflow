import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localExecutionEnabled } from '../src/localExecution.js';
import { tenantEnvironment } from '../src/tenancy.js';

test('local execution requires an explicit disabled policy or the exact legacy deployment sentinel', () => {
  assert.equal(localExecutionEnabled({}), true);
  assert.equal(localExecutionEnabled({ ACP_ENABLED: 'false' }), true);
  assert.equal(localExecutionEnabled({ ACP_ENABLED: 'false', CODEX_EXECUTABLE: '/missing/codex' }), true);
  assert.equal(localExecutionEnabled({ ACP_ENABLED: 'false', CODEX_EXECUTABLE: '/nonexistent/codex' }), false);
  assert.equal(localExecutionEnabled({ LOCAL_EXECUTION_ENABLED: 'false' }), false);
  assert.equal(localExecutionEnabled({ LOCAL_EXECUTION_ENABLED: 'true', ACP_ENABLED: 'false', CODEX_EXECUTABLE: '/nonexistent/codex' }), true);
  assert.throws(() => localExecutionEnabled({ LOCAL_EXECUTION_ENABLED: 'typo' }), /LOCAL_EXECUTION_ENABLED/);
});

test('deployment execution policy applies to all tenants without importing other tenant configuration', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-execution-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'other.env'), 'LOCAL_EXECUTION_ENABLED=true\nCODEX_EXECUTABLE=/tenant/codex\n');
  for (const environment of [{ LOCAL_EXECUTION_ENABLED: 'false' }, { ACP_ENABLED: 'false', CODEX_EXECUTABLE: '/nonexistent/codex' }]) {
    for (const id of ['default', 'other']) {
      const result = tenantEnvironment({ id }, root, { ...environment, TENANT_ENV_DIR: root });
      assert.equal(result.LOCAL_EXECUTION_ENABLED, 'false');
      if (id === 'default') assert.notEqual(result.CODEX_EXECUTABLE, '/tenant/codex');
    }
  }
});
