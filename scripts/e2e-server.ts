import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './testing/database.js';

const port = Number(process.env.BUGFLOW_E2E_PORT || 4191);
const rootDir = await mkdtemp(path.join(tmpdir(), 'bugflow-e2e-'));
const marker = path.join(tmpdir(), `bugflow-e2e-root-${port}.txt`);
await writeFile(marker, rootDir, { encoding: 'utf8', mode: 0o600 });
const app = createApp({ rootDir, environment: {
  DEFAULT_TENANT_TOKEN: 'test-only-token-for-web-e2e-2026-long-enough',
  ACP_ENABLED: 'false',
  CODEX_EXECUTABLE: path.join(rootDir, 'unavailable-codex'),
  IDE_HISTORY_CODEX_DIR: path.join(rootDir, 'missing-codex-history'),
  IDE_HISTORY_CLAUDE_DIR: path.join(rootDir, 'missing-claude-history')
} });
app.server.listen(port, '127.0.0.1');

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try { await app.close(); } finally { await rm(rootDir, { recursive: true, force: true }); await rm(marker, { force: true }); }
}
process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
