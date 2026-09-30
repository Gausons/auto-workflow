import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import pg from 'pg';

const mode = process.argv[2] || 'node';
if (!['node', 'e2e'].includes(mode)) throw new Error('测试模式仅支持 node 或 e2e');
const prefix = `wf_test_${randomBytes(6).toString('hex')}`;
let container: string | undefined;
let client: pg.Client | undefined;
let child: ReturnType<typeof spawn> | undefined;
const env: NodeJS.ProcessEnv = { ...process.env, TEST_SCHEMA_PREFIX: prefix };
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; child?.kill(signal); });
try {
  if (!env.TEST_PGDATABASE) {
    container = `workflow-test-${randomBytes(6).toString('hex')}`;
    docker('run', '-d', '--rm', '--name', container, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=workflow-test-only', '-e', 'POSTGRES_DB=workflow_test', '-e', 'POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=C', 'pgvector/pgvector:0.8.6-pg17-bookworm');
    const binding = docker('port', container, '5432/tcp');
    Object.assign(env, { TEST_PGHOST: '127.0.0.1', TEST_PGPORT: binding.split(':').at(-1), TEST_PGUSER: 'postgres', TEST_PGPASSWORD: 'workflow-test-only', TEST_PGDATABASE: 'workflow_test' });
  }
  if (env.TEST_PGDATABASE !== 'workflow_test') throw new Error('测试仅允许 workflow_test 专用数据库');
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    const candidate = new pg.Client({ host: env.TEST_PGHOST, port: Number(env.TEST_PGPORT || 5432), user: env.TEST_PGUSER, password: env.TEST_PGPASSWORD, database: env.TEST_PGDATABASE, connectionTimeoutMillis: 1000 });
    try { await candidate.connect(); client = candidate; break; }
    catch { await candidate.end().catch(() => {}); await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!client || stopping) throw new Error('测试数据库未就绪');
  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  const args = mode === 'node'
    ? ['--import', 'tsx', '--test', '--test-concurrency=4', ...(process.argv.slice(3).length ? process.argv.slice(3) : readdirSync('test').filter(name => name.endsWith('.test.ts')).map(name => `test/${name}`))]
    : ['exec', 'playwright', 'test', ...process.argv.slice(3)];
  child = spawn(mode === 'node' ? process.execPath : 'pnpm', args, { env, stdio: 'inherit' });
  process.exitCode = await new Promise<number>(resolve => { child!.once('error', () => resolve(1)); child!.once('exit', code => resolve(code ?? 1)); });
} finally {
  try {
    if (client) {
      const schemas = await client.query<{ nspname: string }>('SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2', [prefix.length + 1, prefix + '_']);
      for (const { nspname } of schemas.rows) if (/^wf_test_[a-f0-9_]+$/.test(nspname)) await client.query(`DROP SCHEMA "${nspname}" CASCADE`);
    }
  } finally {
    try { await client?.end(); }
    finally { if (container) docker('rm', '-f', '-v', container); }
  }
}
