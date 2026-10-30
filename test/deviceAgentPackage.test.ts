import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { copyFile, mkdtemp, mkdir, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { connectorDirectory, listConnectors, stopConnector } from '../packages/device-agent/src/control.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('packed device agent installs and runs outside the repository without TypeScript or workspace packages', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-workbench-connector-package-'));
  t.after(async () => {
    try { for (const connector of await listConnectors(directory)) await stopConnector(directory, connector.id); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
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
  const baseEnv = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: directory, USERPROFILE: directory };
  await t.test('installed executable exposes help/version and rejects invalid arguments', async () => {
    const help = (await exec(command, ['--help'], { cwd, env: baseEnv })).stdout;
    assert.match(help, /用法：agent-workbench-connector \[--env-file/);
    assert.match(help, /Agent Workbench 开发机连接器/);
    assert.match(help, /--connect/);
    assert.equal((await exec(command, ['--version'], { cwd, env: baseEnv })).stdout.trim(), manifest.version);
    await assert.rejects(exec(command, ['--bogus'], { cwd, env: baseEnv }));
    await assert.rejects(exec(command, ['--background-worker'], { cwd, env: baseEnv }), /只能由连接器启动/);
    await assert.rejects(exec(command, ['--foreground'], { cwd, env: baseEnv }), /需与 --connect/);
    await assert.rejects(exec(command, ['--env-file', path.join(directory, 'missing.env')], { cwd, env: baseEnv }), /无法读取连接配置|not found/);
    const deployment = Buffer.from(JSON.stringify({ url: 'https://work.example.com', deploymentToken: 'd'.repeat(43), expiresAt: 1 })).toString('base64url');
    await assert.rejects(exec(command, ['--connect', deployment], { cwd, env: baseEnv }), /临时令牌已过期/);
    await assert.rejects(exec(command, ['--connect', deployment, '--once'], { cwd, env: baseEnv }), /不能与/);
    // Node can read --env-file before the application parser, so supply a real empty fixture.
    const emptyConfig = path.join(directory, 'empty.env');
    await writeFile(emptyConfig, '');
    await assert.rejects(exec(command, ['--connect', deployment, '--env-file', emptyConfig], { cwd, env: baseEnv }), /不能与/);
  });
  const stateDir = path.join(directory, 'device-state');
  const historyDir = path.join(directory, 'empty-history'); await mkdir(historyDir);
  const heartbeats: Array<Record<string, unknown>> = [];
  let allowExecution = true, tenantId = 'tenant-one', exchanges = 0, failHeartbeat = false;
  const deployments = new Set<string>(), sessionToken = 's'.repeat(43);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth/device-deployment/exchange') {
      exchanges++;
      if (typeof input.deploymentToken !== 'string' || !deployments.delete(input.deploymentToken)) { res.writeHead(401); res.end('{}'); return; }
      res.end(JSON.stringify({ token: sessionToken })); return;
    }
    if (req.url === '/api/auth/login') {
      assert.equal(input.username, 'fixture-user'); assert.equal(input.password, 'fixture-password');
      res.end(JSON.stringify({ token: 'fixture-token' })); return;
    }
    assert.ok(['Bearer fixture-token', `Bearer ${sessionToken}`].includes(req.headers.authorization || ''));
    if (req.url === '/api/auth/session') {
      res.end(JSON.stringify({ tenant: { id: tenantId }, user: { id: 'user' }, permissions: allowExecution ? ['read', 'work.execute'] : ['read'] })); return;
    }
    if (req.url === '/api/task-center' && req.method === 'POST') {
      if (failHeartbeat) { res.writeHead(503); res.end(JSON.stringify({ message: 'fixture-heartbeat-unavailable' })); return; }
      heartbeats.push(input);
    }
    res.end(JSON.stringify({ handoffs: [], sessions: [], devices: [], tasks: [], executions: [] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let subscriptions = 0;
  const realtime = new WebSocketServer({ server, path: '/api/realtime' });
  realtime.on('connection', socket => socket.on('message', raw => {
    const input = JSON.parse(raw.toString()) as { type: string; token?: string };
    if (input.type === 'subscribe') {
      assert.equal(input.token, sessionToken); subscriptions++;
      socket.send(JSON.stringify({ type: 'ready', channel: 'device-control' }));
    }
  }));
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  t.after(() => new Promise<void>(resolve => { for (const socket of realtime.clients) socket.terminate(); realtime.close(() => resolve()); }));
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
  const backgroundEnv = { ...baseEnv, WORKBENCH_EXECUTE_CODEX: 'false', WORKBENCH_SYNC_EXCERPTS: 'false', WORKBENCH_DEVICE_DIR: stateDir,
    CODEX_WORKSPACE_DIR: cwd, IDE_HISTORY_CODEX_DIR: historyDir, IDE_HISTORY_CLAUDE_DIR: historyDir,
    ACP_ENABLED: 'false', CODEX_EXECUTABLE: path.join(directory, 'missing-codex') };
  const deployment = () => {
    const deploymentToken = randomBytes(32).toString('base64url'); deployments.add(deploymentToken);
    return Buffer.from(JSON.stringify({ url: `http://127.0.0.1:${address.port}`, deploymentToken, expiresAt: Date.now() + 60_000 })).toString('base64url');
  };
  const launch = (encoded = deployment()) => exec(command, ['--connect', encoded], { cwd, env: backgroundEnv, timeout: 15_000 });
  const status = () => exec(command, ['--status'], { cwd, env: baseEnv, timeout: 10_000 });
  const stop = (id: string) => exec(command, ['--stop', id], { cwd, env: baseEnv, timeout: 15_000 });
  const untilStopped = async (id: string) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await listConnectors(directory)).find(item => item.id === id)?.status === 'stopped') return;
      await delay(100);
    }
    assert.fail('fixture connector did not stop');
  };
  await t.test('one-click connection returns after registration, survives its terminal, exposes status and stops gracefully without storing credentials', async () => {
    tenantId = 'tenant-one';
    const encoded = deployment(), before = exchanges;
    const output = await launch(encoded);
    assert.match(output.stdout, /设备已连接.*转入后台/);
    const id = /连接标识：([a-f0-9]{24})/.exec(output.stdout)![1]!;
    assert.ok(heartbeats.length > 2, 'success is reported only after the initial heartbeat');
    assert.match((await status()).stdout, new RegExp(`${id}  运行中`));
    await assert.rejects(launch(encoded), /临时令牌已使用或失效/);
    await assert.rejects(launch(), /已在运行/);
    assert.equal(exchanges, before + 3, 'each user invocation exchanges once; no implicit retry');
    assert.match((await status()).stdout, new RegExp(`${id}  运行中`));
    const record = await readFile(path.join(connectorDirectory(directory), `${id}.json`), 'utf8');
    const info = JSON.parse(record) as { logFile: string; pid: number };
    assert.notEqual(info.pid, process.pid);
    const log = await readFile(info.logFile, 'utf8');
    assert.doesNotMatch(record + log + output.stdout + output.stderr, new RegExp(sessionToken));
    assert.ok(!record.includes(encoded) && !log.includes(encoded));
    if (process.platform !== 'win32') {
      assert.equal((await stat(info.logFile)).mode & 0o777, 0o600);
      assert.equal((await stat(path.join(connectorDirectory(directory), `${id}.json`))).mode & 0o777, 0o600);
    }
    assert.match((await stop(id)).stdout, /已正常停止/);
    assert.match((await stop(id)).stdout, /已停止/);
    assert.match((await status()).stdout, new RegExp(`${id}  已停止`));
  });
  await t.test('concurrent deployments create exactly one worker and a crashed worker can be replaced without reusing its token', async () => {
    const results = await Promise.allSettled([launch(), launch()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const current = (await listConnectors(directory)).find(item => item.status === 'running')!;
    assert.ok(current);
    process.kill(current.pid, 'SIGKILL');
    await untilStopped(current.id);
    await launch();
    const replacement = (await listConnectors(directory)).find(item => item.id === current.id)!;
    assert.equal(replacement.status, 'running'); assert.notEqual(replacement.pid, current.pid);
    await stop(current.id);
  });
  await t.test('unauthorized, cross-tenant and failed registration never report successful background startup or launch replacement workers', async () => {
    allowExecution = false;
    await assert.rejects(launch(), /操作员或管理员权限/);
    allowExecution = true; tenantId = 'tenant-two';
    await assert.rejects(launch(), /属于其他工作台或账号/);
    tenantId = 'tenant-one'; failHeartbeat = true;
    const before = exchanges;
    await assert.rejects(launch(), /fixture-heartbeat-unavailable/);
    assert.equal(exchanges, before + 1);
    assert.ok((await listConnectors(directory)).every(item => item.status === 'stopped'));
    failHeartbeat = false;
    await launch();
    const current = (await listConnectors(directory)).find(item => item.status === 'running')!;
    await stop(current.id);
  });
  await t.test('foreground override stays attached and SIGTERM releases its connection for the next launch', async () => {
    const child = spawn(command, ['--connect', deployment(), '--foreground'], { cwd, env: backgroundEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
    try {
      let current;
      for (let attempt = 0; attempt < 50; attempt++) {
        current = (await listConnectors(directory)).find(item => item.status === 'running');
        if (current) break;
        assert.equal(child.exitCode, null, output); await delay(100);
      }
      assert.ok(current, output); assert.equal(child.exitCode, null);
      assert.match(output, /前台连接设备/);
      child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null]);
      assert.equal((await listConnectors(directory)).find(item => item.id === current.id)?.status, 'stopped');
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } }
  });
  await t.test('background execution keeps its realtime channel after the launcher exits and stops on revoked authorization without restarting', async () => {
    const before = subscriptions;
    await exec(command, ['--connect', deployment()], { cwd, env: { ...backgroundEnv, WORKBENCH_EXECUTE_CODEX: 'true' }, timeout: 15_000 });
    for (let attempt = 0; subscriptions === before && attempt < 50; attempt++) await delay(100);
    assert.equal(subscriptions, before + 1);
    const current = (await listConnectors(directory)).find(item => item.status === 'running')!;
    assert.ok(current);
    for (const socket of realtime.clients) socket.close(4403, 'fixture revoked');
    await untilStopped(current.id);
    await delay(100);
    assert.equal(subscriptions, before + 1, 'revoked authorization must not reconnect or relaunch');
    assert.equal(realtime.clients.size, 0);
  });
});
