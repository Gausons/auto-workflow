import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
let serverEnv = process.env;
if (process.argv[2] === '--remote-db') {
  const profilePath = path.join(root, '.env.server-db');
  if (!existsSync(profilePath)) throw new Error('pnpm dev:remote 需要 .env.server-db');
  const profile = parseEnv(readFileSync(profilePath, 'utf8'));
  const { PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD } = profile;
  if (!PGHOST || !PGPORT || !PGDATABASE || !PGUSER || !PGPASSWORD) {
    throw new Error('.env.server-db 缺少 PostgreSQL 连接配置');
  }
  serverEnv = {
    ...process.env, HOST: '127.0.0.1', DATABASE_DRIVER: 'postgres',
    PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSCHEMA: profile.PGSCHEMA ?? '',
    IMPORT_LEGACY_DATA: 'false',
  };
  const prepare = path.join(root, '.workflow-data/dev-server-db.sh');
  if (!existsSync(prepare)) throw new Error('pnpm dev:remote 需要 .workflow-data/dev-server-db.sh');
  const result = spawnSync('bash', [prepare, '--prepare'], { cwd: root, env: serverEnv, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('服务器数据库连接准备失败');
}

// Keep the same manifest and HTTP origin as production. predev supplies the
// initial assets; subsequent browser edits rebuild without restarting Node.
const watcher = await build({ root, build: { watch: {}, emptyOutDir: false } });
if (!('close' in watcher)) throw new Error('前端构建未进入监听模式');
const frontend = watcher;

const server = spawn(process.execPath, [
  '--import', 'tsx', '--import', './src/issueSources/preload.ts', '--watch', 'server.ts'
], { cwd: root, env: serverEnv, stdio: 'inherit' });

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
