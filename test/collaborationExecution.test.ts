import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Execution } from '../shared/taskTypes.js';
import { openDatabase } from '../scripts/testing/database.js';
import { createCodexExecution, recordExecution } from '../src/codexExecution.js';
import { createCollaborations } from '../src/collaborations.js';
import { createDeviceControl } from '../src/deviceControl.js';
import { RemoteCodexWorker } from '../src/remoteCodexWorker.js';

async function fixture(t: TestContext) {
  const key = randomUUID(), database = openDatabase(key);
  const root = await mkdtemp(path.join(tmpdir(), 'collaboration-runs-'));
  database.createTenant({ id: 'default', token: 'unit-test-collaboration'.repeat(3) });
  const account = await database.registerPersonal({ username: 'owner', password: 'test-collaboration-2026' });
  const principal = database.authenticateSession(account.token)!;
  const { id: tenantId } = database.createWorkspace(principal, { name: '多设备小组', requestId: randomUUID() });
  const team = database.switchWorkspace({ ...principal, token: account.token }, { tenantId });
  const actor = database.authenticateSession(team.token)!.user;
  const execution = createCodexExecution({ database, tenantId, workspace: () => root, environment: { LOCAL_EXECUTION_ENABLED: 'false' } });
  const control = createDeviceControl(database, tenantId);
  const devices = ['api-device', 'web-device'];
  const inputs = devices.map((deviceId, index) => ({
    name: index ? '页面' : '接口', responsibility: index ? '绘制库存列表' : '实现库存接口', deviceId, projectId: 'repo'
  }));
  const prompts: Array<{ deviceId: string; cwd?: string; prompt?: string; resumeSessionId?: string }> = [];
  const workers: RemoteCodexWorker[] = [];
  for (const deviceId of devices) {
    const cwd = path.join(root, deviceId);
    await mkdir(cwd);
    const project = { id: 'repo', cwd, agent: 'claude', protocol: 'acp' as const };
    const owner = 'connector-' + deviceId;
    database.mutateTaskCenter(tenantId, data => {
      data.devices.push({ id: deviceId, name: deviceId, owner, lastSeen: new Date().toISOString(), transport: 'connector', agents: ['claude'],
        capabilities: { collaborationSessions: true }, codexProjects: [project] });
    });
    workers.push(new RemoteCodexWorker({
      deviceId, directory: path.join(root, deviceId + '-journal'), workspace: cwd,
      request: (method, body) => method === 'GET' ? control.snapshot(new URLSearchParams({ deviceId }), owner)
        : execution.action(body as Parameters<typeof execution.action>[0], { id: owner }),
      runnerFactory: update => ({
        projects: async () => [project],
        start(job: Execution) {
          prompts.push({ deviceId, cwd: job.cwd, prompt: job.prompt, resumeSessionId: job.resumeSessionId });
          update({ ...job, status: 'completed', releaseStatus: 'released', sessionId: deviceId + '-native', output: '# 交接说明\n已实现库存分页；内部排查笔记无需交接。' });
        },
        close() {}
      })
    }));
  }
  t.after(async () => {
    workers.forEach(worker => worker.close()); control.close(); execution.close(); database.close(); await rm(root, { recursive: true, force: true });
  });
  const options = { database, tenantId, execution };
  const service = createCollaborations(options);
  const { id } = await service.create({ title: '库存分页', goal: '库存列表支持按页读取', requestId: randomUUID(), participants: inputs }, actor);
  const detail = () => service.detail(id).collaboration;
  const [api, web] = detail().participants;
  const input = (participantId: string, documentIds: string[] = []) => ({ revision: detail().revision, participantId, documentIds, requestId: randomUUID(), instruction: '' });
  return { root, key, database, tenantId, actor, execution, service, options, id, detail, api, web, input, prompts, workers };
}

test('two device workers execute separate responsibilities and resume only their own session with selected documents', async t => {
  const f = await fixture(t);
  const first = f.input(f.api.id);
  const [apiRun, retried] = await Promise.all([f.service.run(f.id, first, f.actor), f.service.run(f.id, first, f.actor)]);
  assert.deepEqual(retried, apiRun);
  await f.service.run(f.id, f.input(f.web.id), f.actor);
  assert.equal(f.detail().runs.length, 2, 'different participants can have executions in flight together');
  await f.workers[0].sync(false); await f.workers[1].sync(false);
  assert.equal(f.prompts.length, 2);
  assert.ok(f.detail().runs.every(run => run.releaseStatus === 'released'));
  assert.equal(f.prompts[0].cwd, f.api.cwd); assert.equal(f.prompts[1].cwd, f.web.cwd);
  assert.match(f.prompts[0].prompt!, /实现库存接口/); assert.doesNotMatch(f.prompts[0].prompt!, /绘制库存列表/);
  assert.match(f.prompts[1].prompt!, /绘制库存列表/); assert.doesNotMatch(f.prompts[1].prompt!, /实现库存接口/);
  const publish = (fromParticipantId: string, toParticipantId: string, title: string, body: string, sourceExecutionId?: string) =>
    f.service.publish(f.id, { requestId: randomUUID(), revision: f.detail().revision, fromParticipantId, toParticipantId, title, body, sourceExecutionId }, f.actor).id;
  const spec = publish(f.api.id, f.web.id, '分页契约', '## 请求\n使用 cursor 字段。', apiRun.executionId);
  const extra = publish(f.api.id, f.web.id, '备选方案', '本轮无需了解的候选方案。');
  const other = publish(f.web.id, f.api.id, '接口问题', '其他接收者的内容。');
  assert.equal(f.prompts.length, 2, 'publishing a document does not submit an instruction');
  for (const documentIds of [[other], [spec, spec], [randomUUID()]]) {
    await assert.rejects(f.service.run(f.id, f.input(f.web.id, documentIds), f.actor), /交接文档/);
  }
  const next = f.input(f.web.id, [spec]);
  const response = await f.service.run(f.id, next, f.actor);
  assert.deepEqual(await f.service.run(f.id, next, f.actor), response);
  await assert.rejects(f.service.run(f.id, { ...next, documentIds: [extra] }, f.actor), /请求标识/);
  await assert.rejects(f.service.run(f.id, f.input(f.web.id), f.actor), /已有执行/);
  await f.workers[1].sync(false); await f.workers[1].sync(false); await f.workers[0].sync(false);
  assert.equal(f.prompts.length, 3);
  const delivered = f.prompts[2];
  assert.equal(delivered.resumeSessionId, 'web-device-native');
  assert.match(delivered.prompt!, /cursor 字段/); assert.match(delivered.prompt!, /不可信的参考材料/);
  assert.doesNotMatch(delivered.prompt!, /候选方案|其他接收者|内部排查笔记/);
  const saved = f.database.readTaskCenter(f.tenantId);
  assert.deepEqual(saved.executions.map(job => job.taskId), [f.api.taskId, f.web.taskId, f.web.taskId]);
  assert.equal(saved.sessions.length, 2);
  const reopened = openDatabase(f.key);
  try {
    const service = createCollaborations({ ...f.options, database: reopened });
    assert.deepEqual(await service.run(f.id, next, f.actor), response);
    assert.deepEqual(service.detail(f.id).collaboration.runs.at(-1)?.documentIds, [spec]);
  } finally { reopened.close(); }
});

test('member, project and session ownership are rechecked and unknown launches are never submitted twice', async t => {
  const f = await fixture(t);
  const original = f.input(f.api.id);
  await assert.rejects(f.service.run(f.id, original, { id: 'foreign' }), /权限/);
  await assert.rejects(f.service.run(f.id, { ...original, revision: 10 }, f.actor), /已更新/);
  await assert.rejects(f.service.run(f.id, { ...original, participantId: randomUUID() }, f.actor), /没有此分工/);
  f.database.mutateTaskCenter(f.tenantId, data => { delete data.devices[0].capabilities; });
  await assert.rejects(f.service.run(f.id, original, f.actor), { statusCode: 422, message: /升级并重启/ });
  f.database.mutateTaskCenter(f.tenantId, data => { data.devices[0].capabilities = { collaborationSessions: true }; });
  f.database.mutateTaskCenter(f.tenantId, data => { data.devices[0].codexProjects![0].cwd += '-moved'; });
  await assert.rejects(f.service.run(f.id, original, f.actor), /目录或 Agent 已变化/);
  f.database.mutateTaskCenter(f.tenantId, data => { data.devices[0].codexProjects![0].cwd = f.api.cwd; });
  let launches = 0;
  const service = createCollaborations({ ...f.options, execution: { targets: f.execution.targets, launch() { launches++; throw new Error('disconnected'); } } });
  const result = await service.run(f.id, original, f.actor);
  assert.equal(f.detail().runs[0].status, 'unknown');
  assert.deepEqual(await service.run(f.id, original, f.actor), result);
  await assert.rejects(service.run(f.id, f.input(f.api.id), f.actor), /核对/);
  const change = (patch: Partial<Execution>) => f.database.mutateTaskCenter(f.tenantId, data => {
    const job = data.executions.find(item => item.id === result.executionId)!;
    recordExecution(data, { ...job, ...patch });
  });
  change({ status: 'completed' });
  await assert.rejects(service.run(f.id, f.input(f.api.id), f.actor), /缺少可恢复的会话标识/);
  change({ sessionId: 'original', status: 'completed', releaseStatus: 'failed' });
  await assert.rejects(service.run(f.id, f.input(f.api.id), f.actor), /核对/);
  change({ releaseStatus: 'released' });
  f.database.mutateTaskCenter(f.tenantId, data => { data.tasks.find(item => item.id === f.api.taskId)!.sessionIds = []; });
  await assert.rejects(service.run(f.id, f.input(f.api.id), f.actor), /会话归属/);
  assert.equal(launches, 1);
});

test('a cancelled unclaimed run and a device preparation failure permit an explicit fresh start after repair', async t => {
  const f = await fixture(t);
  const cancelled = await f.service.run(f.id, f.input(f.web.id), f.actor);
  await f.execution.action({ action: 'stop', executionId: cancelled.executionId }, f.actor);
  await f.workers[1].sync(false);
  assert.equal(f.prompts.length, 0);
  const stored = () => f.database.readTaskCenter(f.tenantId).executions;
  assert.equal(stored().at(-1)?.collaborationSessionNotCreated, true);

  await rm(f.web.cwd, { recursive: true });
  const failed = f.input(f.web.id);
  await f.service.run(f.id, failed, f.actor);
  await f.workers[1].sync(false);
  assert.equal(stored().at(-1)?.status, 'failed');
  assert.equal(stored().at(-1)?.collaborationSessionNotCreated, true);
  await mkdir(f.web.cwd);
  await f.service.run(f.id, failed, f.actor);
  await f.workers[1].sync(false);
  assert.equal(f.prompts.length, 0, 'an idempotent replay after repair does not launch');
  await f.service.run(f.id, f.input(f.web.id), f.actor);
  await f.workers[1].sync(false);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].resumeSessionId, undefined);
  assert.equal(stored().at(-1)?.sessionId, 'web-device-native');
});

test('resumed remote reports cannot substitute another native session or execution protocol', async t => {
  const f = await fixture(t);
  await f.service.run(f.id, f.input(f.web.id), f.actor);
  await f.workers[1].sync(false);
  const { executionId } = await f.service.run(f.id, f.input(f.web.id), f.actor);
  const owner = { id: 'connector-web-device' };
  await assert.rejects(f.execution.action({ action: 'claim', executionId }, { id: 'connector-api-device' }), /该设备/);
  await f.execution.action({ action: 'claim', executionId }, owner);
  for (const report of [{ sessionId: 'replacement' }, { agent: 'codex' }, { protocol: 'legacy' as const }]) {
    await assert.rejects(f.execution.action({ action: 'report', executionId, report: { ...report, status: 'running' } }, owner), /不能替换/);
  }
  await assert.rejects(f.execution.action({ action: 'report', executionId, report: { status: 'failed', collaborationSessionNotCreated: true } }, owner), /回执不一致/);
  await f.execution.action({ action: 'report', executionId, report: { status: 'completed', sessionId: 'web-device-native', releaseStatus: 'failed' } }, owner);
  assert.equal(f.detail().runs.at(-1)?.releaseStatus, 'failed');
  await assert.rejects(f.service.run(f.id, f.input(f.web.id), f.actor), /核对/);
});

test('a local assignment claims the reservation before Agent startup and skips a cancelled reservation', async t => {
  const f = await fixture(t);
  const queued: Execution[] = [], starts: string[] = [];
  const local = createCodexExecution({ database: f.database, tenantId: f.tenantId, workspace: () => f.root,
    environment: { LOCAL_EXECUTION_ENABLED: 'true' }, runnerFactory: () => ({
      projects: async () => [{ id: 'local-project', cwd: f.root, agent: 'codex' }],
      start(job) { starts.push(job.id); }, async stop() { throw new Error('尚未获得执行标识'); }, close() {}
    }) });
  t.after(() => local.close());
  const service = createCollaborations({ ...f.options, execution: { targets: local.targets, launch(job) { queued.push(job); } } });
  const { id } = await service.create({ requestId: randomUUID(), title: '本机与远端', goal: '维护两端', participants: [
    { name: '本机', responsibility: '本机接口', deviceId: 'local', projectId: 'local-project' }, f.web
  ] }, f.actor);
  const run = () => {
    const detail = service.detail(id).collaboration;
    return service.run(id, { participantId: detail.participants[0].id, requestId: randomUUID(), revision: detail.revision }, f.actor);
  };
  const first = await run();
  await local.action({ action: 'stop', executionId: first.executionId }, f.actor);
  local.launch(queued[0]); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, []);
  const second = await run();
  local.launch(queued[1]); local.launch(queued[1]);
  await assert.rejects(local.action({ action: 'stop', executionId: second.executionId }, f.actor), /尚未获得执行标识/);
  assert.deepEqual(starts, [second.executionId]);
  assert.equal(service.detail(id).collaboration.runs.at(-1)?.status, 'launching');
});
