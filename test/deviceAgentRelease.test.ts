import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('agent publication is tag-only, gated by checks, isolated from production and uses the verified archive', async () => {
  const workflow = await readFile('.github/workflows/ci-cd.yml', 'utf8');
  assert.match(workflow, /tags: \['agent-v\*'\]/);
  const job = workflow.split('\n  publish_agent:')[1]!.split('\n  deploy:')[0]!;
  assert.match(job, /needs: checks/);
  assert.match(job, /if: \(github.event_name == 'push' \|\| github.event_name == 'workflow_dispatch'\) && startsWith\(github.ref, 'refs\/tags\/agent-v'\) && github.repository == 'Gausons\/auto-workflow'/);
  assert.match(job, /environment: npm/);
  assert.match(job, /group: npm-agent-workbench-connector\n\s+cancel-in-progress: false/);
  assert.match(job, /id-token: write/);
  assert.match(job, /git merge-base --is-ancestor HEAD origin\/main/);
  assert.match(job, /actions\/download-artifact@[a-f0-9]+[\s\S]*name: agent-workbench-connector/);
  assert.match(job, /npm@11\.5\.1/);
  assert.match(job, /publish "\$AGENT_ARCHIVE" --access public --tag latest --ignore-scripts --registry=https:\/\/registry.npmjs.org/);
  assert.doesNotMatch(job, /agent:pack|pnpm install|DEPLOY_SSH_KEY/);
  assert.match(job, /Verify public installation/);
  assert.equal(workflow.match(/secrets\.NPM_TOKEN/g)?.length, 1);
});

test('release validator rejects invalid tags, metadata mismatch and ambiguous archives before publication', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-workbench-connector-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.resolve('scripts/npm/validate-release.sh');
  const manifest = JSON.parse(await readFile('packages/device-agent/package.json', 'utf8')) as { version: string; name: string };
  const packedManifest = { ...manifest, scripts: {} };
  for (const folder of ['packages/device-agent', 'package', 'dist/device-agent']) {
    await mkdir(path.join(directory, folder), { recursive: true });
  }
  await writeFile(path.join(directory, 'packages/device-agent/package.json'), JSON.stringify(manifest));
  const archive = path.join(directory, `dist/device-agent/agent-workbench-connector-${manifest.version}.tgz`);
  const pack = async (metadata: unknown) => {
    await writeFile(path.join(directory, 'package/package.json'), JSON.stringify(metadata));
    const result = spawnSync('tar', ['-czf', archive, 'package/package.json'], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  const output = path.join(directory, 'output');
  const run = (tag = `agent-v${manifest.version}`) => spawnSync('bash', [script], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_REF_NAME: tag, GITHUB_OUTPUT: output }
  });
  await pack(packedManifest);
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(await readFile(output, 'utf8'), `archive=dist/device-agent/agent-workbench-connector-${manifest.version}.tgz\nversion=${manifest.version}\n`);
  for (const tag of ['main', 'v0.3.0', 'agent-v0.3.0-beta.1', 'agent-v01.3.0', 'agent-v../../bad', 'agent-v0.3.0;echo bad', 'agent-v99.0.0']) {
    assert.notEqual(run(tag).status, 0, tag);
  }
  await pack({ ...packedManifest, version: '99.0.0' });
  assert.notEqual(run().status, 0);
  await pack({ ...packedManifest, name: 'another-package' });
  assert.notEqual(run().status, 0);
  await pack({ ...packedManifest, description: 'different build' });
  assert.notEqual(run().status, 0);
  await pack({ ...packedManifest, scripts: { prepack: 'unexpected' } });
  assert.notEqual(run().status, 0);
  await pack(packedManifest);
  await writeFile(path.join(directory, 'dist/device-agent/extra.tgz'), 'unexpected');
  assert.notEqual(run().status, 0);
  await rm(archive);
  assert.notEqual(run().status, 0);
  // Failed validation must never append outputs that could authorize a later publish step.
  assert.equal((await readFile(output, 'utf8')).split('\n').length, 3);
});
