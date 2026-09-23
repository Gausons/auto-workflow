import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SourceRegistry, freezeSnapshot, packSnapshot, verifyBundle, verifySnapshot } from '@auto-workflow/context-engine';
import { markdownSource } from '@auto-workflow/context-adapters/markdown';
import { readBundleDirectory, writeBundleDirectory } from '@auto-workflow/context-engine/directory-bundle';

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
