import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('CI SSH entrypoint rejects shell access and passes only a validated revision to sudo', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-deploy-test-'));
  try {
    await writeFile(path.join(directory, 'sudo'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const invoke = (command: string) => spawnSync('bash', ['scripts/deploy/ssh-entrypoint.sh'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: command }
    });
    const revision = 'a'.repeat(40);
    for (const command of ['', 'sh', 'whoami', `deploy ${revision}; id`, `deploy ${revision}\nwhoami`, 'deploy ../../etc/passwd', `deploy ${'a'.repeat(39)}`, `deploy ${revision} extra`]) {
      const result = invoke(command);
      assert.equal(result.status, 64, command);
      assert.equal(result.stdout, '', command);
    }
    const result = invoke(`deploy ${revision}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `-n\n/usr/local/sbin/auto-workflow-deploy\n${revision}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
