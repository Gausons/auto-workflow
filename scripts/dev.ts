import { spawn } from 'node:child_process';
import path from 'node:path';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
// Keep the same manifest and HTTP origin as production. predev supplies the
// initial assets; subsequent browser edits rebuild without restarting Node.
const watcher = await build({ root, build: { watch: {}, emptyOutDir: false } });
if (!('close' in watcher)) throw new Error('前端构建未进入监听模式');
const frontend = watcher;

const server = spawn(process.execPath, [
  '--import', 'tsx', '--import', './src/issueSources/preload.ts', '--watch', 'server.ts'
], { cwd: root, stdio: 'inherit' });

let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  const exited = new Promise<void>(resolve => {
    if (server.exitCode !== null || server.signalCode !== null || !server.pid) resolve();
    else server.once('exit', () => resolve());
  });
  server.kill('SIGTERM');
  const deadline = setTimeout(() => server.kill('SIGKILL'), 12000);
  deadline.unref();
  try { await Promise.all([frontend.close(), exited]); }
  finally { clearTimeout(deadline); }
}

server.once('error', error => { console.error(error.message); void stop(1); });
server.once('exit', (code, signal) => { void stop(code ?? (signal ? 1 : 0)); });
process.once('SIGINT', () => { void stop(0); });
process.once('SIGTERM', () => { void stop(0); });
