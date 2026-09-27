import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export default async function teardown() {
  const port = Number(process.env.BUGFLOW_E2E_PORT || 4191);
  const marker = path.join(tmpdir(), `bugflow-e2e-root-${port}.txt`);
  const rootDir = await readFile(marker, 'utf8').catch(() => '');
  if (path.dirname(rootDir) === tmpdir() && path.basename(rootDir).startsWith('bugflow-e2e-')) {
    await rm(rootDir, { recursive: true, force: true });
  }
  await rm(marker, { force: true });
}
