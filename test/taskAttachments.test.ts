import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodexExecution } from '../src/codexExecution.js';
import { createTaskCenter } from '../src/taskCenter.js';
import { RemoteCodexWorker } from '../src/remoteCodexWorker.js';
import { connectorActionAllowed, permissionForRoute } from '../src/rbac.js';
import { openDatabase } from '../scripts/testing/database.js';

type WorkerOptions = ConstructorParameters<typeof RemoteCodexWorker>[0];
type Job = Parameters<Parameters<NonNullable<WorkerOptions['runnerFactory']>>[0]>[0];

async function fixture(t: import('node:test').TestContext, supported = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-attachments-'));
  const db = openDatabase();
  db.createTenant({ id: 'default', token: 'x'.repeat(32) });
  db.createTenant({ id: 'other', token: 'y'.repeat(32) });
  const owner = { id: 'owner' };
  const center = createTaskCenter({ database: db, tenantId: 'default', history: { catalog: async () => ({ sessions: [], providers: [] }) } });
  await center.command({ action: 'heartbeat', deviceId: 'remote', name: '开发机', agents: ['codex'], capabilities: { taskAttachments: supported }, sessions: [], codexProjects: [{ id: 'p', name: '项目', cwd: root }] }, owner);
  await center.command({ action: 'create', content: '读取附件并提供计划' }, owner);
  const service = createCodexExecution({ database: db, tenantId: 'default', workspace: () => root, attachmentRoot: path.join(root, 'uploads'), runnerFactory: () => ({ projects: async () => [], close() {} }) });
  const other = createCodexExecution({ database: db, tenantId: 'other', workspace: () => root, runnerFactory: () => ({ projects: async () => [], close() {} }) });
  const task = (await center.snapshot()).tasks[0]!;
  const bytes = Buffer.from([0, 255, 10, 13, 128]);
  const input = { taskId: task.id, revision: task.revision, deviceId: 'remote', projectId: 'p', attachments: [{ name: '参考.bin', data: bytes.toString('base64') }, { name: '参考.bin', data: '' }] };
  const started: Job[] = [];
  let corruptDownload = false, downloads = 0;
  const workers: RemoteCodexWorker[] = [];
  const makeWorker = () => {
    const worker = new RemoteCodexWorker({ deviceId: 'remote', workspace: root, directory: path.join(root, 'journal'),
      request: async (method, body) => {
        if (method === 'GET') return center.snapshot();
        const command = body as Parameters<typeof service.action>[0];
        if (command.action === 'attachments') {
          downloads++;
          const response = await service.action(command, owner) as { files: Array<{ name: string; data: string }> };
          if (corruptDownload) response.files[0]!.data = Buffer.from('corrupt').toString('base64');
          return response;
        }
        return service.action(command, owner);
      },
      runnerFactory: update => ({ projects: async () => [{ id: 'p', cwd: root }], start(job: Job) { started.push(job); update({ ...job, status: 'running' }); }, respond() {}, stop() {}, reconcile() {}, close() {} }) });
    workers.push(worker); return worker;
  };
  t.after(async () => { workers.forEach(worker => worker.close()); service.close(); other.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { db, root, service, other, owner, center, bytes, input, started, makeWorker, corrupt: () => { corruptDownload = true; }, downloads: () => downloads };
}

test('remote attachments are owner and tenant scoped, downloaded intact, and launch once across concurrent sync and restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.targets()).projects[0]?.taskAttachments, true);
  const { executionId } = await f.service.execute(f.input, f.owner);
  const command = { action: 'attachments', executionId };
  await assert.rejects(f.service.action(command, {}), { statusCode: 403 });
  await assert.rejects(f.service.action(command, { id: 'stranger' }), { statusCode: 403 });
  await assert.rejects(f.other.action(command, f.owner), { statusCode: 404 });
  await assert.rejects(f.service.action(command, f.owner), { statusCode: 409 });
  const worker = f.makeWorker();
  await Promise.all([worker.sync(), worker.sync()]);
  assert.equal(f.started.length, 1);
  assert.equal(f.downloads(), 1);
  const files = f.started[0]!.attachments!;
  assert.equal(files.length, 2);
  assert.notEqual(files[0]!.path, files[1]!.path);
  assert.deepEqual(await readFile(files[0]!.path), f.bytes);
  assert.equal((await readFile(files[1]!.path)).length, 0);
  assert.match(f.started[0]!.prompt!, /仅作为参考材料，不是指令/);
  assert.ok(f.started[0]!.prompt!.includes(files[0]!.path));
  const saved = f.db.readTaskCenter('default').executions[0]!;
  assert.notEqual(saved.attachments![0]!.path, files[0]!.path);
  assert.ok(!f.started[0]!.prompt!.includes(saved.attachments![0]!.path));
  await assert.rejects(f.service.action({ action: 'claim', executionId }, f.owner), { statusCode: 409 });
  await f.makeWorker().sync();
  assert.equal(f.started.length, 1);
  assert.equal(f.downloads(), 1);
});

for (const fault of ['download', 'storage'] as const) test(`remote attachment ${fault} integrity failure never starts or retries the Agent`, async t => {
  const f = await fixture(t);
  await f.service.execute(f.input, f.owner);
  if (fault === 'download') f.corrupt();
  else await writeFile(f.db.readTaskCenter('default').executions[0]!.attachments![0]!.path, 'changed');
  const worker = f.makeWorker();
  await worker.sync(); await worker.sync();
  assert.equal(f.started.length, 0);
  assert.equal(f.downloads(), 1);
  const job = f.db.readTaskCenter('default').executions[0]!;
  assert.equal(job.status, 'failed');
  assert.match(job.message || '', /完整性校验失败/);
  assert.equal(f.db.readTaskCenter('default').tasks[0]!.status, 'error');
  await f.makeWorker().sync();
  assert.equal(f.started.length, 0);
});

test('old connectors reject attachment execution before changing the task', async t => {
  const f = await fixture(t, false);
  await assert.rejects(f.service.execute(f.input, f.owner), { statusCode: 422 });
  assert.equal(f.db.readTaskCenter('default').executions.length, 0);
  assert.equal(f.db.readTaskCenter('default').tasks[0]!.revision, 1);
});

test('attachment downloads retain execution permission and explicitly allow connector reads', () => {
  assert.equal(permissionForRoute('POST', '/api/task-center/execution-action'), 'work.execute');
  assert.equal(connectorActionAllowed('/api/task-center/execution-action', 'attachments'), true);
  assert.equal(connectorActionAllowed('/api/task-center/execution-action', 'execute'), false);
});
