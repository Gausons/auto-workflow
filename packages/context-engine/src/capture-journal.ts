import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { verifySnapshot, type ContextSnapshot } from './index.js';

const invalid = (message: string) => Object.assign(new Error(message), { code: 'INVALID_CAPTURE' });
const maxJournalBytes = 160 * 1024 * 1024;

/** An immutable local capture, keyed by the host's operation id and identity fingerprint. */
export async function loadOrFreezeCapture(directory: string, key: string, identity: string, capture: () => Promise<ContextSnapshot>): Promise<ContextSnapshot> {
  if (!/^[a-f0-9-]{36}$/.test(key) || !/^[a-f0-9]{64}$/.test(identity)) throw invalid('来源冻结标识无效');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `capture-${key}.json`);
  const load = async () => {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxJournalBytes) throw invalid('来源冻结文件无效或超限');
      let saved: { identity?: unknown; snapshot?: unknown };
      try { saved = JSON.parse((await handle.readFile()).toString('utf8')) as typeof saved; }
      catch { throw invalid('来源冻结文件已损坏'); }
      if (saved.identity !== identity) throw invalid('来源冻结身份与当前交接不匹配');
      try { return verifySnapshot(saved.snapshot); } catch { throw invalid('来源冻结快照已损坏'); }
    } finally { await handle.close(); }
  };
  try { return await load(); }
  catch (caught: unknown) { if ((caught as NodeJS.ErrnoException).code !== 'ENOENT') throw caught; }
  const snapshot = verifySnapshot(await capture());
  const bytes = Buffer.from(JSON.stringify({ identity, snapshot }));
  if (bytes.length > maxJournalBytes) throw invalid('来源冻结快照超限');
  const temporary = path.join(directory, `.capture-${randomUUID()}.pending`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, file); }
    catch (caught: unknown) { if ((caught as NodeJS.ErrnoException).code !== 'EEXIST') throw caught; return await load(); }
    return snapshot;
  } finally { await rm(temporary, { force: true }); }
}
