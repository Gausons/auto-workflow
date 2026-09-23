import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyBundle, type ContextBundle, type ContextSnapshot } from './index.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const invalid = () => Object.assign(new Error('交接目录包无效或已变化'), { code: 'INVALID_BUNDLE' });
interface Manifest {
  schemaVersion: 2;
  snapshot: Omit<ContextSnapshot, 'entries'>;
  events: { digest: string; bytes: number };
  objects: Array<{ digest: string; mimeType: string; bytes: number }>;
  manifestDigest: string;
}

export async function writeBundleDirectory(bundle: ContextBundle, parent: string, name: string): Promise<string> {
  verifyBundle(bundle);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name) || name === '.' || name === '..') throw invalid();
  const root = await realpath(parent);
  const destination = path.join(root, name);
  if (await lstat(destination).then(() => true, () => false)) throw invalid();
  const temporary = path.join(root, `.bundle-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    const eventBytes = Buffer.from(JSON.stringify(bundle.snapshot.entries));
    const { entries: _entries, ...snapshot } = bundle.snapshot;
    const manifest: Manifest = { schemaVersion: 2, snapshot, events: { digest: digest(eventBytes), bytes: eventBytes.length },
      objects: bundle.objects.map(({ digest, mimeType, bytes }) => ({ digest, mimeType, bytes })), manifestDigest: bundle.manifestDigest };
    await mkdir(path.join(temporary, 'objects'), { mode: 0o700 });
    await writeFile(path.join(temporary, 'events.json'), eventBytes, { flag: 'wx', mode: 0o600 });
    for (const item of bundle.objects) await writeFile(path.join(temporary, 'objects', item.digest), Buffer.from(item.data, 'base64'), { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    if (await lstat(destination).then(() => true, () => false)) throw invalid();
    await rename(temporary, destination);
    return destination;
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

async function safeRead(file: string, maximum: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw invalid(); });
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) throw invalid();
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function readBundleDirectory(directory: string): Promise<ContextBundle> {
  const requested = path.resolve(directory);
  const info = await lstat(requested).catch(() => { throw invalid(); });
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
  const root = await realpath(requested).catch(() => { throw invalid(); });
  const manifestBytes = await safeRead(path.join(root, 'manifest.json'), 1_000_000);
  let manifest: Manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')) as Manifest; } catch { throw invalid(); }
  if (!manifest || manifest.schemaVersion !== 2 || !manifest.events ||
      !Number.isSafeInteger(manifest.events.bytes) || manifest.events.bytes < 0 || manifest.events.bytes > 85 * 1024 * 1024 ||
      !Array.isArray(manifest.objects) || manifest.objects.length > 1000) throw invalid();
  const eventBytes = await safeRead(path.join(root, 'events.json'), manifest.events.bytes);
  if (eventBytes.length !== manifest.events.bytes || digest(eventBytes) !== manifest.events.digest) throw invalid();
  let entries: ContextSnapshot['entries'];
  try { entries = JSON.parse(eventBytes.toString('utf8')) as ContextSnapshot['entries']; } catch { throw invalid(); }
  const objects: ContextBundle['objects'] = [];
  let total = 0;
  const objectRoot = path.join(root, 'objects');
  if (await realpath(objectRoot).catch(() => '') !== objectRoot) throw invalid();
  for (const item of manifest.objects) {
    if (!item || typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 0) throw invalid();
    total += item.bytes;
    if (total > 85 * 1024 * 1024) throw invalid();
    const bytes = await safeRead(path.join(objectRoot, item.digest), item.bytes);
    if (bytes.length !== item.bytes || digest(bytes) !== item.digest) throw invalid();
    objects.push({ ...item, data: bytes.toString('base64') });
  }
  return verifyBundle({ schemaVersion: 2, snapshot: { ...manifest.snapshot, entries }, objects, manifestDigest: manifest.manifestDigest });
}
