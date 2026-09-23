import { SourceRegistry, freezeSnapshot, packSnapshot } from '@auto-workflow/context-engine';
import { readBundleDirectory, writeBundleDirectory } from '@auto-workflow/context-engine/directory-bundle';
import { markdownSource } from '@auto-workflow/context-adapters/markdown';

const argv = process.argv.slice(2);
const [action, ...args] = argv[0] === '--' ? argv.slice(1) : argv;
if (action === 'pack-markdown' && args.length === 4) {
  const [sourceRoot, relativeFile, destinationParent, name] = args as [string, string, string, string];
  const sources = new SourceRegistry();
  sources.register(markdownSource(sourceRoot));
  const captured = await sources.capture('markdown', relativeFile);
  const snapshot = freezeSnapshot(captured.events, captured.sources, captured.partial);
  const directory = await writeBundleDirectory(packSnapshot(snapshot), destinationParent, name);
  process.stdout.write(JSON.stringify({ directory, digest: snapshot.digest, sources: snapshot.sources, partial: snapshot.partial }) + '\n');
} else if (action === 'verify' && args.length === 1) {
  const bundle = await readBundleDirectory(args[0]!);
  process.stdout.write(JSON.stringify({ digest: bundle.snapshot.digest, manifestDigest: bundle.manifestDigest,
    sources: bundle.snapshot.sources, entries: bundle.snapshot.entries.length, objects: bundle.objects.length,
    partial: bundle.snapshot.partial }) + '\n');
} else {
  process.stderr.write('用法：pnpm context:bundle -- pack-markdown <授权目录> <相对Markdown路径> <目标父目录> <包名>\n'
    + '      pnpm context:bundle -- verify <数据包目录>\n');
  process.exitCode = 2;
}
