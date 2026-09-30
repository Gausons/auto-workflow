import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve('scripts/npm/prepare-release.sh');
const manifest = 'packages/device-agent/package.json';
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const commit = (cwd: string) => git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'fixture');

test('manual release uses only the built-in token and dispatches the existing trusted workflow on the tag', async () => {
  const workflow = await readFile('.github/workflows/release-agent.yml', 'utf8');
  assert.match(workflow, /options: \[patch, minor, major\]/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main' && github.repository == 'Gausons\/auto-workflow'/);
  assert.match(workflow, /group: agent-release-prepare\n\s+cancel-in-progress: false/);
  assert.match(workflow, /contents: write\n\s+actions: write/);
  assert.match(workflow, /RELEASE_BUMP: \$\{\{ inputs.bump \}\}/);
  assert.match(workflow, /gh workflow run ci-cd.yml --ref "\$RELEASE_TAG"/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|id-token: write|npm publish|pnpm install/);
});

test('version preparation uses real Git remotes and preserves release safety', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-version-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let fixtureId = 0;
  const fixture = async (version = '0.3.9') => {
    const directory = path.join(root, String(fixtureId++)); await mkdir(directory);
    const remote = path.join(directory, 'remote.git');
    git(directory, 'init', '--bare', '--initial-branch=main', remote);
    const checkout = path.join(directory, 'checkout');
    git(directory, 'clone', remote, checkout);
    await mkdir(path.join(checkout, 'packages/device-agent'), { recursive: true });
    await writeFile(path.join(checkout, manifest), JSON.stringify({ name: 'agent-workbench-connector', version, description: 'preserve me' }, null, 2) + '\n');
    git(checkout, 'add', '.'); commit(checkout); git(checkout, 'push', 'origin', 'main');
    const base = git(checkout, 'rev-parse', 'HEAD');
    const output = path.join(directory, 'output');
    const run = (bump: string, runId = '123') => spawnSync('bash', [script], {
      cwd: checkout, encoding: 'utf8',
      env: { ...process.env, RELEASE_BUMP: bump, RELEASE_BASE: base, RELEASE_RUN_ID: runId, GITHUB_OUTPUT: output }
    });
    return { directory, remote, checkout, base, output, run };
  };
  for (const [bump, version] of [['patch', '0.3.10'], ['minor', '0.4.0'], ['major', '1.0.0']]) {
    await t.test(`${bump} bumps only the manifest and atomically publishes the commit and tag`, async () => {
      const f = await fixture();
      const before = await readFile(path.join(f.checkout, manifest), 'utf8');
      const result = f.run(bump!); assert.equal(result.status, 0, result.stderr);
      const main = git(f.remote, 'rev-parse', 'main');
      assert.equal(git(f.remote, 'rev-parse', `agent-v${version}`), main);
      assert.equal(git(f.remote, 'rev-parse', 'main^'), f.base);
      assert.equal(git(f.remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', main), manifest);
      assert.equal(await readFile(path.join(f.checkout, manifest), 'utf8'), before.replace('0.3.9', version!));
      assert.equal(await readFile(f.output, 'utf8'), `tag=agent-v${version}\nversion=${version}\n`);
      // GitHub reruns check out the original dispatch SHA, not the bot commit.
      git(f.checkout, 'checkout', '--detach', f.base);
      assert.equal(f.run(bump!).status, 0, 'same run reuses its own release');
      assert.notEqual(f.run(bump!, '999').status, 0, 'another run cannot adopt the tag');
      assert.equal(git(f.remote, 'rev-parse', 'main'), main);
    });
  }
  await t.test('invalid input, dirty checkout and stale main do not push anything', async () => {
    const f = await fixture();
    assert.notEqual(f.run('patch;echo injected').status, 0);
    await writeFile(path.join(f.checkout, 'untracked'), 'user data');
    assert.notEqual(f.run('patch').status, 0);
    await rm(path.join(f.checkout, 'untracked'));
    const other = path.join(f.directory, 'other'); git(f.directory, 'clone', f.remote, other);
    await writeFile(path.join(other, 'new-file'), 'new main'); git(other, 'add', '.'); commit(other); git(other, 'push', 'origin', 'main');
    const current = git(f.remote, 'rev-parse', 'main');
    assert.notEqual(f.run('patch').status, 0);
    assert.equal(git(f.remote, 'rev-parse', 'main'), current);
    assert.equal(git(f.remote, 'tag'), '');
  });
  await t.test('existing unrelated tag is never moved', async () => {
    const f = await fixture();
    git(f.checkout, 'tag', 'agent-v0.3.10'); git(f.checkout, 'push', 'origin', 'agent-v0.3.10');
    assert.notEqual(f.run('patch').status, 0);
    assert.equal(git(f.remote, 'rev-parse', 'agent-v0.3.10'), f.base);
    assert.equal(git(f.remote, 'rev-parse', 'main'), f.base);
  });
  await t.test('protected tag rejection leaves main unchanged because the push is atomic', async () => {
    const f = await fixture();
    await writeFile(path.join(f.remote, 'hooks/update'), '#!/bin/sh\ncase "$1" in refs/tags/*) exit 1 ;; esac\n', { mode: 0o755 });
    assert.notEqual(f.run('patch').status, 0);
    assert.equal(git(f.remote, 'rev-parse', 'main'), f.base);
    assert.equal(git(f.remote, 'tag'), '');
  });
  await t.test('prerelease and unsafe versions are rejected', async () => {
    for (const version of ['0.3.0-beta.1', '01.2.3', '1.2.9007199254740991']) {
      const f = await fixture(version);
      assert.notEqual(f.run('patch').status, 0);
      assert.equal(git(f.remote, 'rev-parse', 'main'), f.base);
    }
  });
});
