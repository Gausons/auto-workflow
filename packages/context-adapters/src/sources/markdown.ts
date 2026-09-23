import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SourceAdapter } from '@auto-workflow/context-engine';

const maxBytes = 16 * 1024 * 1024;
const invalid = () => Object.assign(new Error('Markdown 来源不在授权目录内或已变化'), { code: 'INVALID_SOURCE' });

/** Read-only document source. The host supplies a tenant-scoped root. */
export function markdownSource(root: string): SourceAdapter<string> {
  return { id: 'markdown', async capture(relativePath) {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0') ||
        relativePath.split(/[\\/]/).some(part => part === '..') || path.extname(relativePath).toLowerCase() !== '.md') throw invalid();
    const allowed = await realpath(root);
    const requested = path.resolve(allowed, relativePath);
    if (!requested.startsWith(allowed + path.sep)) throw invalid();
    let resolved: string;
    try { resolved = await realpath(requested); } catch { throw invalid(); }
    if (!resolved.startsWith(allowed + path.sep) || resolved !== requested) throw invalid();
    const handle = await open(requested, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw invalid(); });
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > maxBytes) throw invalid();
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino ||
          await realpath(requested).catch(() => '') !== resolved) throw invalid();
      const source = `markdown:${createHash('sha256').update(relativePath).update('\0').update(bytes).digest('hex')}`;
      return { events: [{ role: 'reference', text: bytes.toString('utf8'), source }], sources: [source], partial: false };
    } finally { await handle.close(); }
  } };
}
