import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const project = path.resolve(import.meta.dirname, '..');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-dev-'));
  await Promise.all(['scripts', 'src/issueSources', 'web/src'].map(dir => mkdir(path.join(root, dir), { recursive: true })));
  await symlink(path.join(project, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  await cp(path.join(project, 'scripts/dev.ts'), path.join(root, 'scripts/dev.ts'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'vite.config.ts'), 'export default { build: { outDir: "public/build", manifest: true, rollupOptions: { input: "web/src/main.ts" } } };');
  await writeFile(path.join(root, 'src/issueSources/preload.ts'), 'export {};');
  await writeFile(path.join(root, 'web/src/main.ts'), 'console.log("first-build");');
  return root;
}

function launch(root: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/dev.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  async function until(check: () => Promise<boolean> | boolean) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await check()) return;
      assert.equal(child.exitCode, null, output);
      await delay(100);
    }
    assert.fail(`开发监听未完成：${output}`);
  }
  return { child, exited, until, output: () => output };
}

test('development rebuilds browser assets, restarts the server and closes both watchers', { timeout: 45000 }, async () => {
  const root = await fixture();
  const server = (label: string) => `import http from 'node:http';
const server = http.createServer((req, res) => res.end('${label}'));
server.listen(0, '127.0.0.1', () => console.log('READY:${label}:' + server.address().port));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
process.once('SIGINT', () => server.close(() => process.exit(0)));
`;
  await writeFile(path.join(root, 'server.ts'), server('first'));
  const run = launch(root);
  try {
    const manifestPath = path.join(root, 'public/build/.vite/manifest.json');
    const entry = async () => {
      try { return (JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, { file: string }>)['web/src/main.ts']?.file; }
      catch { return undefined; }
    };
    await run.until(async () => Boolean(await entry()) && /READY:first:\d+/.test(run.output()));
    const original = await entry();
    await writeFile(path.join(root, 'web/src/main.ts'), 'console.log("second-build");');
    await run.until(async () => { const next = await entry(); return Boolean(next && next !== original); });
    assert.match(await readFile(path.join(root, 'public/build', (await entry())!), 'utf8'), /second-build/);
    await writeFile(path.join(root, 'server.ts'), server('second'));
    await run.until(() => /READY:second:\d+/.test(run.output()));
    const port = /READY:second:(\d+)/.exec(run.output())![1];
    const url = `http://127.0.0.1:${port}`;
    assert.equal(await (await fetch(url)).text(), 'second');
    run.child.kill('SIGTERM');
    assert.deepEqual(await run.exited, [0, null]);
    await assert.rejects(fetch(url));
  } finally {
    if (run.child.exitCode === null && run.child.signalCode === null) { run.child.kill('SIGTERM'); await run.exited; }
    await rm(root, { recursive: true, force: true });
  }
});

test('development closes the browser watcher when the server launcher fails', { timeout: 30000 }, async () => {
  const root = await fixture();
  // Let the fixture application finish before terminating its watch launcher,
  // so this failure-path test never leaves an application process behind.
  await writeFile(path.join(root, 'server.ts'), 'console.log("LAUNCHER:" + process.ppid);');
  const run = launch(root);
  try {
    await run.until(() => /LAUNCHER:\d+/.test(run.output()) && /Completed running/.test(run.output()));
    process.kill(Number(/LAUNCHER:(\d+)/.exec(run.output())![1]), 'SIGKILL');
    const [code] = await run.exited;
    assert.notEqual(code, 0);
  } finally {
    if (run.child.exitCode === null && run.child.signalCode === null) { run.child.kill('SIGTERM'); await run.exited; }
    await rm(root, { recursive: true, force: true });
  }
});
