import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('failed Docker health checks restore the previous container without restoring the database', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-docker-test-'));
  try {
    const bin = path.join(directory, 'bin');
    const base = path.join(directory, 'app');
    const data = path.join(directory, 'data');
    const config = path.join(directory, 'config');
    await Promise.all([bin, path.join(base, 'backups'), data, config].map(dir => mkdir(dir, { recursive: true })));
    await writeFile(path.join(data, 'workflow.sqlite'), 'existing-database');
    await writeFile(path.join(config, 'auto-workflow.env'), 'TEST=value');
    const revision = 'a'.repeat(40);
    const log = path.join(directory, 'commands');
    const mock = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$COMMAND_LOG"
case "$1" in
  image)
    if [[ "$*" == *Architecture* ]]; then echo linux/amd64; else echo "$REVISION"; fi ;;
  inspect)
    if [[ "$*" == *RestartPolicy* ]]; then echo unless-stopped; else echo auto-workflow:previous; fi ;;
  exec) exit 1 ;;
esac
`;
    await writeFile(path.join(bin, 'docker'), mock, { mode: 0o755 });
    for (const command of ['flock', 'sleep', 'tar']) await writeFile(path.join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(path.join(bin, 'id'), '#!/bin/sh\necho 1000\n', { mode: 0o755 });
    // Isolate OS paths and root-only validation; all Docker operations are recorded fixtures.
    const source = (await readFile('scripts/deploy/release.sh', 'utf8'))
      .replace(/^export PATH=.*$/m, `export PATH="${bin}:$PATH"`)
      .replace('$EUID == 0 && ', '')
      .replace('base=/opt/auto-workflow', `base="${base}"`)
      .replace('data=/var/lib/auto-workflow', `data="${data}"`)
      .replaceAll('/etc/auto-workflow', config)
      .replace('/run/lock/auto-workflow-deploy.lock', path.join(directory, 'lock'))
      .replace('/var/tmp/auto-workflow-image.', path.join(directory, 'image.'));
    const script = path.join(directory, 'release.sh');
    await writeFile(script, source);
    const result = spawnSync('bash', [script, revision], { encoding: 'utf8', input: 'fixture-image',
      env: { ...process.env, COMMAND_LOG: log, REVISION: revision } });
    assert.equal(result.status, 1, result.stderr);
    const commands = (await readFile(log, 'utf8')).split('\n');
    assert.ok(commands.includes('rm -f auto-workflow'));
    assert.ok(commands.some(command => /^rename auto-workflow-previous-.* auto-workflow$/.test(command)));
    assert.ok(commands.includes('update --restart=unless-stopped auto-workflow'));
    assert.equal(commands.filter(command => command === 'start auto-workflow').length, 2);
    assert.equal(await readFile(path.join(data, 'workflow.sqlite'), 'utf8'), 'existing-database');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
