import { createHash, randomUUID } from 'node:crypto';
import { openDatabase as openApplicationDatabase } from '../../src/database.js';
import { createApp as createApplication } from '../../server.js';
import { openPostgres, postgresConfig } from '../../src/storage/postgres.js';
export { hashToken } from '../../src/database.js';

const environments = new Map<string, Record<string, string>>();
export function databaseEnvironment(key: string = randomUUID()): Record<string, string> {
  const existing = environments.get(key);
  if (existing) return existing;
  if (process.env.TEST_PGDATABASE !== 'workflow_test' || !/^wf_test_[a-f0-9]{12}$/.test(process.env.TEST_SCHEMA_PREFIX || '')) {
    throw new Error('请通过 pnpm test 或 scripts/testing/run.ts 运行数据库测试，禁止使用业务库');
  }
  const environment = {
    DATABASE_DRIVER: 'postgres', PGHOST: process.env.TEST_PGHOST || '127.0.0.1',
    PGPORT: process.env.TEST_PGPORT || '5432', PGUSER: process.env.TEST_PGUSER || 'postgres',
    PGPASSWORD: process.env.TEST_PGPASSWORD || '', PGDATABASE: 'workflow_test',
    PGSCHEMA: `${process.env.TEST_SCHEMA_PREFIX}_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
  };
  const admin = openPostgres({ ...postgresConfig({ ...environment, PGSCHEMA: undefined }), initializeSchema: false });
  try { admin.prepare(`CREATE SCHEMA IF NOT EXISTS "${environment.PGSCHEMA}"`).run(); }
  finally { admin.close(); }
  environments.set(key, environment);
  return environment;
}
export function openDatabase(key?: string) {
  return openApplicationDatabase(databaseEnvironment(key));
}
export function rawDatabase(key: string) { return openPostgres(postgresConfig(databaseEnvironment(key))); }
export function createApp(options: Parameters<typeof createApplication>[0] = {}) {
  const key = options.rootDir || randomUUID();
  const app = createApplication({ ...options, environment: { ...options.environment, ...databaseEnvironment(key) } });
  return { ...app, databaseKey: key };
}
