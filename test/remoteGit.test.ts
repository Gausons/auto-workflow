import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../scripts/testing/database.js';
import { createTaskCenter } from '../src/taskCenter.js';
import { createCodexExecution } from '../src/codexExecution.js';
import { createRemoteGit } from '../src/remoteGit.js';
import { syncRemoteGit } from '../src/remoteGitWorker.js';
import { gitBranches, switchGitBranch } from '../src/taskWorkspace.js';

async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-git-'));
  const git = (...args: string[]) => promisify(execFile)('git', ['-C', root, ...args]);
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.com');
  await writeFile(path.join(root, 'file.txt'), 'main'); await git('add', '.'); await git('commit', '-m', 'init');
  const db = openDatabase(); db.createTenant({ id: 'default', token: 'x'.repeat(32) }); db.createTenant({ id: 'other', token: 'y'.repeat(32) });
  const owner = { id: 'owner' }, actor = { id: 'operator' };
  const projects = [{ id: 'p', name: 'Codex', cwd: root }];
  const center = createTaskCenter({ database: db, tenantId: 'default', history: { catalog: async () => ({ sessions: [], providers: [] }) } });
  await center.command({ action: 'heartbeat', deviceId: 'remote', name: 'Mac', agents: ['codex'], sessions: [], codexProjects: projects, capabilities: { gitBranches: true } }, owner);
  const service = createRemoteGit(db, 'default');
  const execution = createCodexExecution({ database: db, tenantId: 'default', workspace: () => root, runnerFactory: () => ({ projects: async () => [], close() {} }) });
  let loseReport = false;
  const worker = { deviceId: 'remote', directory: path.join(root, 'journal'), projects: async () => projects,
    request: async (_method: string, body?: unknown) => {
      const input = body as Parameters<typeof service.action>[0];
      if (loseReport && input.action === 'report') { loseReport = false; throw new Error('network lost'); }
      return service.action(input, owner);
    } };
  const input = (action: 'list' | 'create' | 'switch' = 'list', branch?: string) => ({ requestId: randomUUID(), deviceId: 'remote', projectId: 'p', action, branch });
  const sync = () => syncRemoteGit(worker, db.readTaskCenter('default'));
  t.after(async () => { execution.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, git, db, owner, actor, service, execution, input, sync, worker, loseReport: () => { loseReport = true; } };
}

test('remote branches list, create and switch, preserving dirty files on conflict', async t => {
  const f = await fixture(t);
  const list = f.service.submit(f.input(), f.actor); await f.sync();
  assert.equal(f.service.status(list.id, f.actor).result?.current, 'main');
  const input = f.input('create', 'feature');
  const create = f.service.submit(input, f.actor); await f.sync();
  assert.equal(f.service.status(create.id, f.actor).result?.current, 'feature');
  assert.equal(f.service.submit(input, f.actor).id, create.id);
  await writeFile(path.join(f.root, 'file.txt'), 'feature'); await f.git('commit', '-am', 'feature');
  const back = f.service.submit(f.input('switch', 'main'), f.actor); await f.sync();
  assert.equal(f.service.status(back.id, f.actor).result?.current, 'main');
  await writeFile(path.join(f.root, 'file.txt'), 'unsaved');
  const conflict = f.service.submit(f.input('switch', 'feature'), f.actor); await f.sync();
  assert.equal(f.service.status(conflict.id, f.actor).status, 'failed');
  assert.match(f.service.status(conflict.id, f.actor).message!, /未强制覆盖/);
  assert.equal(await readFile(path.join(f.root, 'file.txt'), 'utf8'), 'unsaved');
});

test('remote git enforces requester, connector, tenant and directory boundaries', async t => {
  const f = await fixture(t), input = f.input();
  assert.throws(() => f.service.submit(input, {}), { statusCode: 403 });
  const request = f.service.submit(input, f.actor);
  assert.throws(() => f.service.status(request.id, f.owner), { statusCode: 403 });
  assert.throws(() => f.service.action({ action: 'claim', requestId: request.id }, f.actor), { statusCode: 403 });
  const other = createRemoteGit(f.db, 'other');
  assert.throws(() => other.status(request.id, f.actor), { statusCode: 404 });
  assert.throws(() => other.submit(f.input(), f.actor), { statusCode: 404 });
  assert.throws(() => f.service.submit({ ...f.input(), cwd: '/outside' }, f.actor), { statusCode: 403 });
  assert.throws(() => f.service.submit({ ...input, action: 'create', branch: 'different' }, f.actor), { statusCode: 409 });
  assert.throws(() => f.service.submit(f.input('switch', '-f'), f.actor), { statusCode: 400 });
  f.db.mutateTaskCenter('default', data => { data.devices[0]!.capabilities = {}; });
  assert.throws(() => f.service.submit(f.input(), f.actor), /升级/);
  f.db.mutateTaskCenter('default', data => { data.devices[0]!.capabilities = { gitBranches: true }; data.devices[0]!.lastSeen = '2000-01-01'; });
  assert.throws(() => f.service.submit(f.input(), f.actor), /离线/);
});

test('remote git mutations and execution claims exclude one another', async t => {
  const f = await fixture(t);
  const request = f.service.submit(f.input('create', 'feature'), f.actor);
  assert.throws(() => f.service.submit(f.input('switch', 'main'), f.actor), { statusCode: 409 });
  const task = await f.execution.targets(); assert.equal(task.projects[0]?.gitBranches, true);
  const jobId = randomUUID();
  f.db.mutateTaskCenter('default', data => { data.executions.push({ id: jobId, taskId: 'task', deviceId: 'remote', cwd: f.root, status: 'queued', title: 'task', prompt: 'test', contextVersion: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); });
  await assert.rejects(f.execution.action({ action: 'claim', executionId: jobId }, f.owner), { statusCode: 409 });
  await f.sync(); assert.equal(f.service.status(request.id, f.actor).status, 'completed');
  await f.execution.action({ action: 'claim', executionId: jobId }, f.owner);
  assert.throws(() => f.service.submit(f.input('switch', 'main'), f.actor), /正在执行/);
  const reading = f.service.submit(f.input(), f.actor); await f.sync();
  assert.equal(f.service.status(reading.id, f.actor).result?.current, 'feature');
});

test('lost reports replay the receipt, never the Git operation; interrupted claims stay unknown', async t => {
  const f = await fixture(t);
  const request = f.service.submit(f.input('create', 'feature'), f.actor);
  f.loseReport(); await assert.rejects(f.sync(), /network lost/);
  assert.equal((await gitBranches(f.root)).current, 'feature');
  await switchGitBranch(f.root, 'main');
  await f.sync();
  assert.equal(f.service.status(request.id, f.actor).result?.current, 'feature');
  assert.equal((await gitBranches(f.root)).current, 'main');
  const interrupted = f.service.submit(f.input('create', 'never-created'), f.actor);
  const claimed = f.service.action({ action: 'claim', requestId: interrupted.id }, f.owner);
  assert.throws(() => f.service.action({ action: 'claim', requestId: interrupted.id }, f.owner), { statusCode: 409 });
  await mkdir(path.join(f.worker.directory, 'git'), { recursive: true });
  await writeFile(path.join(f.worker.directory, 'git', `${interrupted.id}.json`), JSON.stringify({ ...claimed, status: 'unknown', message: '结果待核对' }));
  await f.sync();
  assert.equal(f.service.status(interrupted.id, f.actor).status, 'running', 'another connector must not release a live claim');
  f.db.mutateTaskCenter('default', data => { data.gitRequests!.find(r => r.id === interrupted.id)!.updatedAt = '2000-01-01'; });
  await f.sync();
  assert.equal(f.service.status(interrupted.id, f.actor).status, 'unknown');
  assert.ok(!(await gitBranches(f.root)).branches.includes('never-created'));
  const expired = f.service.submit(f.input(), f.actor);
  f.db.mutateTaskCenter('default', data => { data.gitRequests!.find(r => r.id === expired.id)!.updatedAt = '2000-01-01'; });
  assert.equal(f.service.status(expired.id, f.actor).status, 'failed');
});

test('worker revalidates the published project before touching a repository', async t => {
  const f = await fixture(t), request = f.service.submit(f.input('create', 'blocked'), f.actor);
  await syncRemoteGit({ ...f.worker, projects: async () => [] }, f.db.readTaskCenter('default'));
  assert.equal(f.service.status(request.id, f.actor).status, 'failed');
  assert.ok(!(await gitBranches(f.root)).branches.includes('blocked'));
});

test('only the requester who selected a remote directory may use it for Git', async t => {
  const f = await fixture(t);
  const cwd = path.join(f.root, 'selected'); await mkdir(cwd);
  f.db.mutateTaskCenter('default', data => { data.directoryRequests = [{ id: randomUUID(), deviceId: 'remote', projectId: 'p', requestedBy: f.actor.id, status: 'completed', cwd, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]; });
  assert.throws(() => f.service.submit({ ...f.input(), cwd }, f.owner), { statusCode: 403 });
  const request = f.service.submit({ ...f.input(), cwd }, f.actor); await f.sync();
  assert.equal(f.service.status(request.id, f.actor).result?.current, 'main');
});

test('an expired claim cannot start a delayed Git mutation', async t => {
  const f = await fixture(t), request = f.service.submit(f.input('create', 'too-late'), f.actor);
  await syncRemoteGit({ ...f.worker, projects: async () => {
    f.db.mutateTaskCenter('default', data => { data.gitRequests!.find(r => r.id === request.id)!.updatedAt = '2000-01-01'; });
    return f.worker.projects();
  } }, f.db.readTaskCenter('default'));
  assert.equal(f.service.status(request.id, f.actor).status, 'unknown');
  assert.ok(!(await gitBranches(f.root)).branches.includes('too-late'));
});
