import { randomUUID } from 'node:crypto';
import { link, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeImmutableContextFile(file: string, content: string | Buffer, conflictMessage: string) {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  const temporary = path.join(path.dirname(file), '.context-' + randomUUID() + '.pending');
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try { await link(temporary, file); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await readFile(file)).equals(bytes)) throw new Error(conflictMessage);
    }
  } finally { await rm(temporary, { force: true }); }
}
