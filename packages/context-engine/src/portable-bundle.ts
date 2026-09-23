import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { detachSnapshot, restoreDetachedSnapshot, verifyDetachedManifest, type DetachedBundle } from './detached-bundle.js';
import { verifySnapshot, type ContextSnapshot } from './index.js';

const invalid = () => Object.assign(new Error('离线交接包无效或已变化'), { code: 'INVALID_BUNDLE' });
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const maxManifestBytes = 128 * 1024 * 1024;

async function readRegular(file: string, maximum: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw invalid(); });
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) throw invalid();
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function directoryRoot(directory: string): Promise<string> {
  const requested = path.resolve(directory);
  const info = await lstat(requested).catch(() => { throw invalid(); });
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
  return await realpath(requested).catch(() => { throw invalid(); });
}

export async function writeDetachedBundleDirectory(snapshot: ContextSnapshot, parent: string, name: string): Promise<string> {
  if (!namePattern.test(name) || name === '.' || name === '..') throw invalid();
  const bundle = detachSnapshot(verifySnapshot(snapshot));
  const manifestBytes = Buffer.from(JSON.stringify(bundle.manifest));
  if (manifestBytes.length > maxManifestBytes) throw invalid();
  const root = await directoryRoot(parent);
  const destination = path.join(root, name);
  await mkdir(destination, { mode: 0o700 }).catch(() => { throw invalid(); });
  try {
    const objects = path.join(destination, 'objects');
    await mkdir(objects, { mode: 0o700 });
    for (const item of bundle.objects) await writeFile(path.join(objects, item.digest), item.data, { flag: 'wx', mode: 0o600 });
    // The manifest is the publication marker; readers reject directories without it.
    await writeFile(path.join(destination, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
    return destination;
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}

export async function readDetachedBundleDirectory(directory: string): Promise<DetachedBundle & { snapshot: ContextSnapshot }> {
  const root = await directoryRoot(directory);
  let manifest: ReturnType<typeof verifyDetachedManifest>;
  try { manifest = verifyDetachedManifest(JSON.parse((await readRegular(path.join(root, 'manifest.json'), maxManifestBytes)).toString('utf8'))); }
  catch { throw invalid(); }
  const objectRoot = path.join(root, 'objects');
  if (await realpath(objectRoot).catch(() => '') !== objectRoot) throw invalid();
  const objects: DetachedBundle['objects'] = [];
  for (const item of manifest.objects) {
    const data = await readRegular(path.join(objectRoot, item.digest), item.bytes);
    objects.push({ ...item, data });
  }
  let snapshot: ContextSnapshot;
  try { snapshot = restoreDetachedSnapshot(manifest, new Map(objects.map(item => [item.digest, item.data]))); }
  catch { throw invalid(); }
  return { manifest, objects, snapshot };
}

export async function importDetachedSnapshotDirectory(directory: string, destinationParent: string, name: string): Promise<{ file: string; snapshot: ContextSnapshot }> {
  if (!namePattern.test(name) || name === '.' || name === '..' || !name.endsWith('.json')) throw invalid();
  const { snapshot } = await readDetachedBundleDirectory(directory);
  const root = await directoryRoot(destinationParent);
  const destination = path.join(root, name);
  const temporary = path.join(root, `.snapshot-${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
    await link(temporary, destination);
    return { file: destination, snapshot };
  } finally { await rm(temporary, { force: true }); }
}
