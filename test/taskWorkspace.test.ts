import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { gitBranches, switchGitBranch, decodeAttachments, saveAttachments } from '../src/taskWorkspace.js';
import { permissionForRoute } from '../src/rbac.js';
const exec = promisify(execFile);
test('branches create and switch without destroying conflicting uncommitted work', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'task-git-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => exec('git', ['-C', dir, ...args]);
  assert.equal((await gitBranches(dir)).repository, false);
  await git('init', '-b', 'main'); await git('config', 'user.email', 'test@example.com'); await git('config', 'user.name', 'Test');
  await writeFile(path.join(dir, 'sample.txt'), 'main'); await git('add', '.'); await git('commit', '-m', 'init');
  assert.equal((await switchGitBranch(dir, 'feature', true)).current, 'feature');
  await writeFile(path.join(dir, 'sample.txt'), 'feature'); await git('commit', '-am', 'feature');
  await switchGitBranch(dir, 'main'); await writeFile(path.join(dir, 'sample.txt'), 'unsaved');
  await assert.rejects(switchGitBranch(dir, 'feature'), /未强制覆盖/);
  assert.equal(await readFile(path.join(dir, 'sample.txt'), 'utf8'), 'unsaved');
  assert.equal((await gitBranches(dir)).current, 'main');
  await assert.rejects(switchGitBranch(dir, '--discard-changes'), /无效/);
  await assert.rejects(switchGitBranch(dir, '../escape', true), /无效/);
});
test('attachments validate limits and paths, preserve binary bytes and duplicate names', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'task-files-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from([0, 255, 12, 128]);
  const files = decodeAttachments([{name:'image.png',data:bytes.toString('base64')},{name:'image.png',data:''}]);
  const saved = await saveAttachments(dir, files);
  assert.deepEqual(await readFile(saved.files[0]!.path), bytes);
  assert.notEqual(saved.files[0]!.path, saved.files[1]!.path);
  assert.throws(() => decodeAttachments([{name:'../escape',data:''}]), /名称无效/);
  assert.throws(() => decodeAttachments([{name:'file',data:'!invalid'}]), /编码无效/);
  assert.throws(() => decodeAttachments(Array(11).fill({name:'file',data:''})), /10/);
  assert.throws(() => decodeAttachments([{name:'large',data:Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')}]), /5 MB/);
});

test('git route requires execution permission', () => { assert.equal(permissionForRoute('POST', '/api/task-center/git'), 'work.execute'); assert.equal(permissionForRoute('GET', '/api/task-center/git'), null); });
