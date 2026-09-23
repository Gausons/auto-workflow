import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SourceRegistry, freezeSnapshot, packSnapshot, verifyBundle, verifySnapshot } from '@auto-workflow/context-engine';
import { markdownSource } from '@auto-workflow/context-adapters/markdown';
import { issueRecordSource } from '@auto-workflow/context-adapters/issue';
import { readBundleDirectory, writeBundleDirectory } from '@auto-workflow/context-engine/directory-bundle';
import { detachSnapshot, restoreDetachedSnapshot, verifyDetachedManifest } from '@auto-workflow/context-engine/detached-bundle';
import { importDetachedSnapshotDirectory, readDetachedBundleDirectory, writeDetachedBundleDirectory } from '@auto-workflow/context-engine/portable-bundle';
import { loadOrFreezeCapture } from '@auto-workflow/context-engine/capture-journal';

test('a new source enters the same capture, snapshot and bundle flow', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'notes.md'), '# 要求\n保留原接口兼容');
  const registry = new SourceRegistry();
  registry.register(markdownSource(root));
  const capture = await registry.capture('markdown', 'notes.md');
  const snapshot = freezeSnapshot(capture.events, capture.sources, capture.partial);
  const bundle = packSnapshot(snapshot, [{ mimeType: 'text/plain', bytes: Buffer.from('evidence') }]);
  assert.deepEqual(verifyBundle(JSON.parse(JSON.stringify(bundle))).snapshot, snapshot);
  assert.equal(bundle.objects.length, 1);
  assert.match(snapshot.entries[0]!.text, /保留原接口兼容/);
  await assert.rejects(registry.capture('markdown', 'missing.md'), { code: 'INVALID_SOURCE' });
  assert.throws(() => registry.register(markdownSource(root)), { code: 'INVALID_CONTEXT' });
});

test('source and bundle reject path escapes, changed evidence and tampering', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = path.join(os.tmpdir(), `outside-${path.basename(root)}.md`);
  t.after(() => rm(outside, { force: true }));
  await writeFile(outside, 'private');
  await symlink(outside, path.join(root, 'link.md'));
  await mkdir(path.join(root, 'nested'));
  const source = markdownSource(root);
  await assert.rejects(source.capture('../outside.md'), { code: 'INVALID_SOURCE' });
  await assert.rejects(source.capture('link.md'), { code: 'INVALID_SOURCE' });
  const snapshot = freezeSnapshot([{ role: 'user', text: '任务', source: 's' }], ['s']);
  const bundle = packSnapshot(snapshot, [{ mimeType: 'image/png', bytes: Buffer.from('image') }]);
  assert.throws(() => verifyBundle({ ...bundle, manifestDigest: '0'.repeat(64) }), { code: 'INVALID_CONTEXT' });
  assert.throws(() => verifyBundle({ ...bundle, objects: [{ ...bundle.objects[0], data: Buffer.from('other').toString('base64') }] }), { code: 'INVALID_CONTEXT' });
  assert.throws(() => verifySnapshot({ ...snapshot, entries: [{ ...snapshot.entries[0], text: 'changed' }] }), { code: 'INVALID_CONTEXT' });
});

test('portable directory bundle survives a fresh read and detects damaged objects', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = freezeSnapshot([{ role: 'reference', text: '跨机证据', source: 'markdown:one' }], ['markdown:one']);
  const bundle = packSnapshot(snapshot, [{ mimeType: 'text/plain', bytes: Buffer.from('原始附件') }]);
  const directory = await writeBundleDirectory(bundle, root, 'handoff');
  assert.deepEqual(await readBundleDirectory(directory), bundle);
  await assert.rejects(writeBundleDirectory(bundle, root, 'handoff'), { code: 'INVALID_BUNDLE' });
  await writeFile(path.join(directory, 'objects', bundle.objects[0]!.digest), '损坏');
  await assert.rejects(readBundleDirectory(directory), { code: 'INVALID_BUNDLE' });
});

test('detached transfer preserves the exact v1 snapshot and deduplicates original image bytes', () => {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const uri = `data:image/png;base64,${bytes.toString('base64')}`;
  const snapshot = freezeSnapshot([
    { role: 'user', source: 'session-a', text: JSON.stringify([{ type: 'input_text', text: '看图片' }, { type: 'input_image', image_url: uri }]) },
    { role: 'assistant', source: 'session-a', text: `已看到 ${uri}` }
  ], ['session-a']);
  const detached = detachSnapshot(snapshot);
  assert.equal(detached.objects.length, 1);
  assert.doesNotMatch(JSON.stringify(detached.manifest), /iVBORw0KGgo/);
  assert.deepEqual(restoreDetachedSnapshot(detached.manifest, new Map(detached.objects.map(item => [item.digest, item.data]))), snapshot);
  assert.throws(() => verifyDetachedManifest({ ...detached.manifest, events: [] }), { code: 'INVALID_BUNDLE' });
  assert.throws(() => restoreDetachedSnapshot(detached.manifest, new Map()), { code: 'INVALID_BUNDLE' });
  assert.throws(() => restoreDetachedSnapshot(detached.manifest, new Map([[detached.objects[0]!.digest, Buffer.from('tampered')]])), { code: 'INVALID_BUNDLE' });
});

test('v3 offline bundle can be copied, verified and imported without replacing an existing snapshot', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  await mkdir(source); await mkdir(target);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const snapshot = freezeSnapshot([{ role: 'user', source: 'remote:a', text: `请看 data:image/png;base64,${image.toString('base64')}` }], ['remote:a']);
  const written = await writeDetachedBundleDirectory(snapshot, source, 'handoff');
  await cp(written, path.join(target, 'handoff'), { recursive: true });
  const copied = path.join(target, 'handoff');
  const checked = await readDetachedBundleDirectory(copied);
  assert.deepEqual(checked.snapshot, snapshot);
  assert.deepEqual(checked.objects[0]!.data, image);
  assert.equal(checked.manifest.schemaVersion, 3);
  const imported = await importDetachedSnapshotDirectory(copied, target, 'snapshot.json');
  assert.deepEqual(JSON.parse(await readFile(imported.file, 'utf8')), snapshot);
  await assert.rejects(importDetachedSnapshotDirectory(copied, target, 'snapshot.json'), { code: 'EEXIST' });
  await assert.rejects(writeDetachedBundleDirectory(snapshot, source, 'handoff'), { code: 'INVALID_BUNDLE' });
  await writeFile(path.join(copied, 'objects', checked.objects[0]!.digest), 'broken');
  await assert.rejects(readDetachedBundleDirectory(copied), { code: 'INVALID_BUNDLE' });
});

test('v3 offline bundle rejects symlinks and unsafe names', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = freezeSnapshot([{ role: 'reference', source: 'a', text: 'evidence' }], ['a']);
  const directory = await writeDetachedBundleDirectory(snapshot, root, 'handoff');
  await assert.rejects(writeDetachedBundleDirectory(snapshot, root, '../outside'), { code: 'INVALID_BUNDLE' });
  await assert.rejects(importDetachedSnapshotDirectory(directory, root, '../outside.json'), { code: 'INVALID_BUNDLE' });
  const alias = path.join(root, 'alias');
  await symlink(directory, alias);
  await assert.rejects(readDetachedBundleDirectory(alias), { code: 'INVALID_BUNDLE' });
  await rm(path.join(directory, 'manifest.json'));
  await symlink(path.join(root, 'missing'), path.join(directory, 'manifest.json'));
  await assert.rejects(readDetachedBundleDirectory(directory), { code: 'INVALID_BUNDLE' });
});

test('bundle CLI exports, verifies and imports a snapshot independently of a task', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = freezeSnapshot([{ role: 'reference', source: 'issue:one', text: '问题记录' }], ['issue:one']);
  const input = path.join(root, 'input.json');
  await writeFile(input, JSON.stringify(snapshot));
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', path.resolve('scripts/context-bundle.ts'), ...args],
    { cwd: path.resolve('.'), encoding: 'utf8' })) as Record<string, unknown>;
  assert.equal(cli('pack-snapshot', input, root, 'portable').digest, snapshot.digest);
  assert.equal(cli('verify', path.join(root, 'portable')).digest, snapshot.digest);
  assert.equal(cli('import-snapshot', path.join(root, 'portable'), root, 'imported.json').digest, snapshot.digest);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'imported.json'), 'utf8')), snapshot);
  await writeFile(path.join(root, 'notes.md'), '# 离线交接');
  const markdown = cli('pack-markdown', root, 'notes.md', root, 'markdown');
  assert.equal(cli('verify', path.join(root, 'markdown')).digest, markdown.digest);
  const legacy = await writeBundleDirectory(packSnapshot(snapshot), root, 'legacy');
  assert.equal(cli('verify', legacy).digest, snapshot.digest);
});

test('capture journal reuses one sealed snapshot after restart and rejects identity drift or corruption', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = randomUUID(), identity = 'a'.repeat(64);
  const first = freezeSnapshot([{ role: 'user', source: 'session-a', text: '冻结前' }], ['session-a']);
  let reads = 0;
  assert.deepEqual(await loadOrFreezeCapture(root, key, identity, async () => { reads++; return first; }), first);
  assert.deepEqual(await loadOrFreezeCapture(root, key, identity, async () => { reads++; throw new Error('不应重读来源'); }), first);
  assert.equal(reads, 1);
  await assert.rejects(loadOrFreezeCapture(root, key, 'b'.repeat(64), async () => first), { code: 'INVALID_CAPTURE' });
  await writeFile(path.join(root, `capture-${key}.json`), '{broken');
  await assert.rejects(loadOrFreezeCapture(root, key, identity, async () => first), { code: 'INVALID_CAPTURE' });
  const concurrentKey = randomUUID();
  const second = freezeSnapshot([{ role: 'user', source: 'session-a', text: '并发来源' }], ['session-a']);
  const concurrent = await Promise.all([first, second].map(snapshot => loadOrFreezeCapture(root, concurrentKey, identity, async () => snapshot)));
  assert.equal(concurrent[0]!.digest, concurrent[1]!.digest);
  assert.equal((await loadOrFreezeCapture(root, concurrentKey, identity, async () => { throw new Error('不应重读'); })).digest, concurrent[0]!.digest);
});

test('issue source captures authorized records through the common engine without mutating provider state', async () => {
  let reads = 0;
  const registry = new SourceRegistry();
  registry.register(issueRecordSource(async id => {
    reads++;
    return id === 'BUG-1' ? { id, source: 'jira', code: id, title: '修复登录', description: '复现步骤',
      attachments: [{ name: '截图.png', url: 'https://example.test/screenshot.png', contentType: 'image/png' }] } : null;
  }));
  const captured = await registry.capture('issue', 'BUG-1');
  assert.equal(reads, 1); assert.equal(captured.events.length, 2); assert.equal(captured.partial, true);
  const snapshot = freezeSnapshot(captured.events, captured.sources, captured.partial);
  assert.deepEqual(verifyBundle(packSnapshot(snapshot)).snapshot, snapshot);
  assert.match(captured.events[1]!.text, /reference_only/);
  await assert.rejects(registry.capture('issue', 'BUG-2'), /不存在/);
});
