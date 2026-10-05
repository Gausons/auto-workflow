import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('CI publishes verified images, negotiates registry deployment and promotes latest after verification', async () => {
  const workflow = await readFile('.github/workflows/ci-cd.yml', 'utf8');
  assert.match(workflow, /REGISTRY_IMAGE: ghcr\.io\/gausons\/auto-workflow/);
  assert.match(workflow, /Publish verified commit image[\s\S]*github\.ref == 'refs\/heads\/main'[\s\S]*docker push "\$tagged"/);
  assert.match(workflow, /image=\$\(docker image inspect[\s\S]*RepoDigests/);
  assert.match(workflow, /verified_image: \$\{\{ steps\.publish_image\.outputs\.image \}\}/);
  const publicCheck = workflow.indexOf('Verify public HTTPS');
  const promotion = workflow.indexOf('Promote deployed image to latest');
  assert.ok(publicCheck >= 0 && promotion > publicCheck);
  assert.match(workflow.slice(publicCheck, workflow.indexOf('\n      - name:', publicCheck)), /if: steps\.revision\.outputs\.current == 'true' && vars\.DEPLOY_VERIFY_PUBLIC_HTTPS == 'true'/);
  assert.match(workflow.slice(promotion), /needs\.checks\.outputs\.verified_image/);
  assert.match(workflow.slice(promotion), /docker buildx imagetools create --tag "\$REGISTRY_IMAGE:latest" "\$VERIFIED_IMAGE"/);
  assert.match(workflow, /capability=.*capabilities[\s\S]*registry-v1/);
  assert.match(workflow, /"deploy \$GITHUB_SHA \$digest"/);
  assert.match(workflow, /using the release archive[\s\S]*"deploy \$GITHUB_SHA" < release\.tar\.gz/);
});

test('CI SSH entrypoint rejects shell access and passes only a validated revision to sudo', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-deploy-test-'));
  try {
    await writeFile(path.join(directory, 'sudo'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const invoke = (command: string) => spawnSync('bash', ['scripts/deploy/ssh-entrypoint.sh'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: command }
    });
    const revision = 'a'.repeat(40);
    const digest = `sha256:${'b'.repeat(64)}`;
    for (const command of ['', 'sh', 'whoami', `deploy ${revision}; id`, `deploy ${revision}\nwhoami`, 'deploy ../../etc/passwd', `deploy ${'a'.repeat(39)}`, `deploy ${revision} sha256:${'b'.repeat(63)}`, `deploy ${revision} sha256:${'g'.repeat(64)}`, `deploy ${revision} extra`]) {
      const result = invoke(command);
      assert.equal(result.status, 64, command);
      assert.equal(result.stdout, '', command);
    }
    const result = invoke(`deploy ${revision}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `-n\n/usr/local/sbin/auto-workflow-deploy\n${revision}\n`);
    const registry = invoke(`deploy ${revision} ${digest}`);
    assert.equal(registry.status, 0, registry.stderr);
    assert.equal(registry.stdout, `-n\n/usr/local/sbin/auto-workflow-deploy\n${revision}\n${digest}\n`);
    const capabilities = invoke('capabilities');
    assert.equal(capabilities.status, 0, capabilities.stderr);
    assert.equal(capabilities.stdout, 'registry-v1\n');
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
    await writeFile(path.join(data, 'workflow.database-key'), 'existing-database');
    await writeFile(path.join(data, 'POSTGRES_MIGRATED'), 'verified');
    await writeFile(path.join(config, 'auto-workflow.env'), 'TEST=value');
    const revision = 'a'.repeat(40);
    const digest = `sha256:${'b'.repeat(64)}`;
    const log = path.join(directory, 'commands');
    const mock = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$COMMAND_LOG"
case "$1" in
  image)
    if [[ "$*" == *Architecture* ]]; then echo linux/amd64; else echo "$REVISION"; fi ;;
  inspect)
    if [[ "$*" == *Health.Status* ]]; then echo healthy; elif [[ "$*" == *RestartPolicy* ]]; then echo unless-stopped; else echo auto-workflow:previous; fi ;;
  exec) if [[ "$*" == *pg_dump* ]]; then echo fixture-postgres-backup; else exit 1; fi ;;
esac
`;
    await writeFile(path.join(bin, 'docker'), mock, { mode: 0o755 });
    for (const command of ['flock', 'sleep', 'tar']) await writeFile(path.join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(path.join(bin, 'id'), '#!/bin/sh\necho 1000\n', { mode: 0o755 });
    // Isolate OS paths and root-only validation; all Docker operations are recorded fixtures.
    const source = (await readFile('scripts/deploy/release.sh', 'utf8'))
      .replace(/^export PATH=.*$/m, `export PATH="${bin}:$PATH"`)
      .replace('[[ $EUID == 0 ]] || exit 64', 'true')
      .replace('base=/opt/auto-workflow', `base="${base}"`)
      .replace('data=/var/lib/auto-workflow', `data="${data}"`)
      .replaceAll('/etc/auto-workflow', config)
      .replace('/run/lock/auto-workflow-deploy.lock', path.join(directory, 'lock'))
      .replace('/var/tmp/auto-workflow-image.', path.join(directory, 'image.'));
    const script = path.join(directory, 'release.sh');
    await writeFile(script, source);
    const result = spawnSync('bash', [script, revision, digest], { encoding: 'utf8',
      env: { ...process.env, COMMAND_LOG: log, REVISION: revision } });
    assert.equal(result.status, 1, result.stderr);
    const commands = (await readFile(log, 'utf8')).split('\n');
    assert.ok(commands.includes('rm -f auto-workflow'));
    assert.ok(commands.some(command => /^rename auto-workflow-previous-.* auto-workflow$/.test(command)));
    assert.ok(commands.includes('update --restart=unless-stopped auto-workflow'));
    assert.equal(commands.filter(command => command === 'start auto-workflow').length, 2);
    assert.ok(commands.includes(`pull ghcr.io/gausons/auto-workflow@${digest}`));
    assert.ok(!commands.some(command => command.startsWith('load ')));
    assert.equal(await readFile(path.join(data, 'workflow.database-key'), 'utf8'), 'existing-database');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
