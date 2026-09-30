import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { copyFile, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('packed device agent installs and runs outside the repository without TypeScript or workspace packages', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-workbench-connector-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await exec('pnpm', ['--dir', path.join(root, 'packages/device-agent'), 'pack', '--pack-destination', directory], { cwd: root, timeout: 30000 });
  const archive = path.join(directory, (await readdir(directory)).find(name => name.endsWith('.tgz'))!);
  const { stdout: listing } = await exec('tar', ['-tzf', archive]);
  assert.deepEqual(listing.trim().split('\n').sort(), ['package/README.md', 'package/dist/LICENSE', 'package/dist/agent.mjs', 'package/package.json']);
  const releaseRoot = path.join(directory, 'release');
  await mkdir(path.join(releaseRoot, 'packages/device-agent'), { recursive: true });
  await mkdir(path.join(releaseRoot, 'dist/device-agent'), { recursive: true });
  await copyFile(path.join(root, 'packages/device-agent/package.json'), path.join(releaseRoot, 'packages/device-agent/package.json'));
  await copyFile(archive, path.join(releaseRoot, 'dist/device-agent', path.basename(archive)));
  const sourceManifest = JSON.parse(await readFile(path.join(root, 'packages/device-agent/package.json'), 'utf8')) as { version: string };
  await exec('bash', [path.join(root, 'scripts/npm/validate-release.sh')], {
    cwd: releaseRoot,
    env: { ...process.env, GITHUB_REF_NAME: `agent-v${sourceManifest.version}`, GITHUB_OUTPUT: path.join(directory, 'release-output') }
  });
  const install = path.join(directory, 'installed'); await mkdir(install);
  const { packageManager } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { packageManager: string };
  // Corepack must use the same pinned pnpm outside the repository as it does inside it.
  await writeFile(path.join(install, 'package.json'), JSON.stringify({ private: true, packageManager }));
  // A fresh consumer has neither registry metadata nor tarballs cached. The SDK is
  // a public runtime dependency; an offline install accidentally tests the host cache.
  const installEnv = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: directory, CI: 'true' };
  try {
    await exec('pnpm', [
      '--dir', install, 'add', '--ignore-scripts',
      '--registry=https://registry.npmjs.org',
      '--store-dir', path.join(directory, 'store'), '--cache-dir', path.join(directory, 'cache'),
      '--fetch-retries=1', '--fetch-timeout=20000', archive
    ], { cwd: install, env: installEnv, timeout: 60000 });
  } catch (error) {
    // pnpm prints dependency resolution errors to stdout, which execFile otherwise hides.
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`连接器全新环境安装失败：${failure.message}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`, { cause: error });
  }
  const command = path.join(install, 'node_modules', '.bin', 'agent-workbench-connector');
  const manifest = JSON.parse(await readFile(path.join(install, 'node_modules/agent-workbench-connector/package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> };
  assert.ok(Object.values(manifest.dependencies).every(value => !value.startsWith('workspace:')));
  const cwd = path.join(directory, 'unrelated'); await mkdir(cwd);
  const baseEnv = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT };
  await t.test('installed executable exposes help/version and rejects invalid arguments', async () => {
    const help = (await exec(command, ['--help'], { cwd, env: baseEnv })).stdout;
    assert.match(help, /用法：agent-workbench-connector \[--env-file/);
    assert.match(help, /Agent Workbench 开发机连接器/);
    assert.equal((await exec(command, ['--version'], { cwd, env: baseEnv })).stdout.trim(), manifest.version);
    await assert.rejects(exec(command, ['--bogus'], { cwd, env: baseEnv }));
    await assert.rejects(exec(command, ['--env-file', path.join(directory, 'missing.env')], { cwd, env: baseEnv }), /无法读取连接配置|not found/);
  });
  const stateDir = path.join(directory, 'device-state');
  const historyDir = path.join(directory, 'empty-history'); await mkdir(historyDir);
  const heartbeats: Array<Record<string, unknown>> = [];
  let allowExecution = true, tenantId = 'tenant-one';
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth/login') {
      assert.equal(input.username, 'fixture-user'); assert.equal(input.password, 'fixture-password');
      res.end(JSON.stringify({ token: 'fixture-token' })); return;
    }
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    if (req.url === '/api/auth/session') {
      res.end(JSON.stringify({ tenant: { id: tenantId }, user: { id: 'user' }, permissions: allowExecution ? ['read', 'work.execute'] : ['read'] })); return;
    }
    if (req.url === '/api/task-center' && req.method === 'POST') heartbeats.push(input);
    res.end(JSON.stringify({ handoffs: [], sessions: [], devices: [], tasks: [], executions: [] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const config = path.join(directory, 'agent.env');
  await writeFile(config, [
    `WORKBENCH_URL=http://127.0.0.1:${address.port}`, 'WORKBENCH_USERNAME=fixture-user', 'WORKBENCH_PASSWORD=fixture-password',
    'WORKBENCH_EXECUTE_CODEX=false', 'WORKBENCH_SYNC_EXCERPTS=false', `WORKBENCH_DEVICE_DIR=${stateDir}`,
    `CODEX_WORKSPACE_DIR=${cwd}`, `IDE_HISTORY_CODEX_DIR=${historyDir}`, `IDE_HISTORY_CLAUDE_DIR=${historyDir}`,
    'ACP_ENABLED=false', `CODEX_EXECUTABLE=${path.join(directory, 'missing-codex')}`
  ].join('\n'), { mode: 0o600 });
  const args = ['--env-file', config, '--once'];
  await t.test('authenticates and syncs from an env file, retaining device identity across working directories', async () => {
    const first = await exec(command, args, { cwd, env: baseEnv });
    assert.match(first.stdout, /同步 0 个会话/);
    assert.doesNotMatch(first.stdout + first.stderr, /fixture-password|fixture-token/);
    assert.equal(heartbeats.length, 1, 'bundled entry must not run twice');
    const id = heartbeats[0]!.deviceId;
    await exec(command, args, { cwd: directory, env: baseEnv });
    assert.equal(heartbeats.length, 2); assert.equal(heartbeats[1]!.deviceId, id);
    assert.equal((await readFile(path.join(stateDir, 'id'), 'utf8')).trim(), id);
  });
  await t.test('environment overrides files and execution cannot run in one-shot mode', async () => {
    await assert.rejects(exec(command, args, { cwd, env: { ...baseEnv, WORKBENCH_EXECUTE_CODEX: 'true' } }), /需要保持连接器运行/);
    assert.equal(heartbeats.length, 2);
  });
  await t.test('rejects read-only login and reusing another tenant’s journal', async () => {
    allowExecution = false;
    await assert.rejects(exec(command, args, { cwd, env: baseEnv }), /接入设备需要操作员或管理员权限/);
    allowExecution = true; tenantId = 'tenant-two';
    await assert.rejects(exec(command, args, { cwd, env: baseEnv }), /状态目录|账号|绑定/);
    assert.equal(heartbeats.length, 2);
  });
});
