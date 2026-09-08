import { existsSync, readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export function readEnvFile(filename) {
  return existsSync(filename) ? parseEnv(readFileSync(filename, 'utf8')) : {};
}

export function loadEnvironment(rootDir) {
  return { ...readEnvFile(path.join(rootDir, '.env')), ...process.env };
}

export function databasePath(rootDir, environment) {
  return path.resolve(rootDir, environment.DATABASE_PATH || '.workflow-data/workflow.sqlite');
}

export const generateToken = () => randomBytes(32).toString('base64url');

export function provisionDefaultTenant(database, rootDir, environment) {
  if (database.getTenant('default')) return false;
  const token = environment.DEFAULT_TENANT_TOKEN || generateToken();
  // Save the generated token before inserting its hash, so an interrupted initialization is recoverable.
  const dir = path.dirname(databasePath(rootDir, environment));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!environment.DEFAULT_TENANT_TOKEN) {
    writeFileSync(path.join(dir, 'default-token'), `${token}\n`, { mode: 0o600 });
  }
  database.createTenant({ id: 'default', name: '默认团队', token });
  return true;
}

export function tenantEnvironment(tenant, rootDir, environment) {
  // Explicit allowlist for OS tooling. Never pass server or other tenants' credentials to a child process.
  const result = {};
  for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SYSTEMROOT']) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  const prefix = /^(PM_|CODEX_|CLAUDE_|IDE_|OPENAI_|ANTHROPIC_|AI_|ENABLE_|ALLOW_|ALLOWED_|REQUIRE_|OPERATION_LOG_|POLL_)/;
  if (tenant.id === 'default') {
    for (const [key, value] of Object.entries(environment)) {
      if (prefix.test(key)) result[key] = value;
    }
  }
  const tenantDir = path.resolve(rootDir, environment.TENANT_ENV_DIR || '.workflow-data/tenants');
  for (const [key, value] of Object.entries(readEnvFile(path.join(tenantDir, `${tenant.id}.env`)))) {
    if (prefix.test(key)) result[key] = value;
  }
  if (result.CODEX_WORKSPACE_DIR) result.CODEX_WORKSPACE_DIR = path.resolve(rootDir, result.CODEX_WORKSPACE_DIR);
  return result;
}

export function canonicalWorkspace(value) {
  let current = path.resolve(value);
  const suffix = [];
  while (!existsSync(current)) {
    suffix.unshift(path.basename(current));
    current = path.dirname(current);
  }
  return path.join(realpathSync(current), ...suffix);
}

export function assertSeparateWorkspaces(entries) {
  const workspaces = entries.filter((entry) => entry.workspace).map((entry) => ({ ...entry, workspace: canonicalWorkspace(entry.workspace) }));
  for (let i = 0; i < workspaces.length; i++) {
    for (let j = i + 1; j < workspaces.length; j++) {
      const a = workspaces[i], b = workspaces[j];
      if (a.workspace === b.workspace || a.workspace.startsWith(`${b.workspace}${path.sep}`) || b.workspace.startsWith(`${a.workspace}${path.sep}`)) {
        throw new Error(`租户 ${a.id} 和 ${b.id} 的 IDE 工作目录重叠，请配置独立仓库目录`);
      }
    }
  }
}
