import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { SourceRegistry, freezeSnapshot, verifySnapshot } from '@auto-workflow/context-engine';
import { readBundleDirectory } from '@auto-workflow/context-engine/directory-bundle';
import { importDetachedSnapshotDirectory, readDetachedBundleDirectory, writeDetachedBundleDirectory } from '@auto-workflow/context-engine/portable-bundle';
import { markdownSource } from '@auto-workflow/context-adapters/markdown';

async function readSnapshotFile(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 160 * 1024 * 1024) throw new Error('快照文件无效或超出大小限制');
    return verifySnapshot(JSON.parse((await handle.readFile()).toString('utf8')));
  } finally { await handle.close(); }
}

const argv = process.argv.slice(2);
const [action, ...args] = argv[0] === '--' ? argv.slice(1) : argv;
if (action === 'pack-markdown' && args.length === 4) {
  const [sourceRoot, relativeFile, destinationParent, name] = args as [string, string, string, string];
  const sources = new SourceRegistry();
  sources.register(markdownSource(sourceRoot));
  const captured = await sources.capture('markdown', relativeFile);
  const snapshot = freezeSnapshot(captured.events, captured.sources, captured.partial);
  const directory = await writeDetachedBundleDirectory(snapshot, destinationParent, name);
  process.stdout.write(JSON.stringify({ directory, digest: snapshot.digest, sources: snapshot.sources, partial: snapshot.partial }) + '\n');
} else if (action === 'pack-snapshot' && args.length === 3) {
  const [file, destinationParent, name] = args as [string, string, string];
  const snapshot = await readSnapshotFile(file);
  const directory = await writeDetachedBundleDirectory(snapshot, destinationParent, name);
  process.stdout.write(JSON.stringify({ directory, digest: snapshot.digest, sources: snapshot.sources, partial: snapshot.partial }) + '\n');
} else if (action === 'verify' && args.length === 1) {
  const directory = args[0]!;
  let result: { snapshot: { digest: string; sources: string[]; entries: unknown[]; partial: boolean }; manifestDigest: string; objects: unknown[] };
  try {
    const bundle = await readDetachedBundleDirectory(directory);
    result = { snapshot: bundle.snapshot, manifestDigest: bundle.manifest.manifestDigest, objects: bundle.objects };
  } catch (error) {
    if ((error as { code?: string }).code !== 'INVALID_BUNDLE') throw error;
    result = await readBundleDirectory(directory);
  }
  process.stdout.write(JSON.stringify({ digest: result.snapshot.digest, manifestDigest: result.manifestDigest,
    sources: result.snapshot.sources, entries: result.snapshot.entries.length, objects: result.objects.length,
    partial: result.snapshot.partial }) + '\n');
} else if (action === 'import-snapshot' && args.length === 3) {
  const [directory, destinationParent, name] = args as [string, string, string];
  const imported = await importDetachedSnapshotDirectory(directory, destinationParent, name);
  process.stdout.write(JSON.stringify({ file: imported.file, digest: imported.snapshot.digest,
    sources: imported.snapshot.sources, partial: imported.snapshot.partial }) + '\n');
} else {
  process.stderr.write('用法：pnpm context:bundle -- pack-markdown <授权目录> <相对Markdown路径> <目标父目录> <包名>\n'
    + '      pnpm context:bundle -- pack-snapshot <快照JSON> <目标父目录> <包名>\n'
    + '      pnpm context:bundle -- verify <数据包目录>\n'
    + '      pnpm context:bundle -- import-snapshot <v3数据包目录> <目标父目录> <文件名.json>\n');
  process.exitCode = 2;
}
