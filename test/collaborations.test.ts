import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { openDatabase } from '../scripts/testing/database.js';
import type { AgentProject, Execution } from '../shared/taskTypes.js';
import { createCollaborations } from '../src/collaborations.js';
import { createCodexExecution } from '../src/codexExecution.js';
import { createTaskCenter } from '../src/taskCenter.js';

async function fixture(t: TestContext) {
  const key = randomUUID(), database = openDatabase(key);
  t.after(() => database.close());
  database.createTenant({ id: 'default', token: randomUUID() });
  const registered = await database.registerPersonal({ username: `collab-${randomUUID()}`, password: 'collaboration-test-password' });
  const personal = database.authenticateSession(registered.token)!;
  const { id: tenantId } = database.createWorkspace(personal, { name: '研发组', requestId: randomUUID() });
  const team = database.authenticateSession(database.switchWorkspace(personal, { tenantId }).token)!;
  const actor = { id: team.user.id };
  const projects: AgentProject[] = [
    { deviceId: 'web', id: 'ui', agent: 'codex', cwd: '/front', online: true, protocol: 'acp', collaborationSessions: true },
    { deviceId: 'server', id: 'api', agent: 'claude', cwd: '/back', online: true, protocol: 'acp', collaborationSessions: true }
  ];
  const execution = { targets: async () => ({ projects }), launch(_job: Execution) {} };
  const options = { database, execution, tenantId };
  const service = createCollaborations(options);
  const input = {
    requestId: randomUUID(), title: '上线搜索', goal: '前端与服务端分别交付搜索功能',
    participants: projects.map(({ deviceId, id }, index) => ({
      name: index ? '接口' : '界面', responsibility: index ? '搜索服务' : '搜索表单', deviceId, projectId: id
    }))
  };
  return { key, options, service, input, actor, personal, team };
}

test('collaboration creates one common task and independent parts atomically, including concurrent retries and reads of old tenant data', async t => {
  const { key, options, service, input, actor } = await fixture(t);
  assert.deepEqual(service.list(), { collaborations: [] });
  const [{ id }, repeated] = await Promise.all([service.create(input, actor), service.create(input, actor)]);
  assert.equal(repeated.id, id);
  const { collaboration } = service.detail(id);
  assert.equal(collaboration.title, input.title);
  assert.equal(collaboration.documentCount, 0);
  assert.equal(collaboration.participantCount, 2);
  assert.deepEqual(collaboration.participants.map(p => [p.deviceId, p.projectId, p.cwd, p.agent]), [
    ['web', 'ui', '/front', 'codex'], ['server', 'api', '/back', 'claude']
  ]);
  const data = options.database.readTaskCenter(options.tenantId);
  assert.equal(data.tasks.length, 3);
  assert.ok(data.tasks.every(task => task.collaborationId === id));
  assert.equal(data.tasks.find(task => task.id === collaboration.parentTaskId)?.content, input.goal);
  for (const part of collaboration.participants) {
    const child = data.tasks.find(task => task.id === part.taskId)!;
    assert.equal(child.content, part.responsibility);
    assert.equal(child.parentTaskId, collaboration.parentTaskId);
  }
  assert.equal(data.executions?.length || 0, 0);
  const reopened = openDatabase(key);
  try {
    assert.deepEqual(createCollaborations({ ...options, database: reopened }).detail(id), { collaboration });
  } finally { reopened.close(); }
  await assert.rejects(service.create({ ...input, goal: '其他目标' }, actor), /请求标识/);
  await assert.rejects(service.create({ ...input, requestId: randomUUID(), participants: input.participants.slice(0, 1) }, actor), /2–6/);
  await assert.rejects(service.create({ ...input, requestId: randomUUID(), participants: [input.participants[0], input.participants[0]] }, actor), /唯一/);
  options.execution.targets = async () => ({ projects: [] });
  assert.equal((await service.create(input, actor)).id, id);
  await assert.rejects(service.create({ ...input, requestId: randomUUID() }, actor));
  assert.equal(options.database.readTaskCenter(options.tenantId).tasks.length, 3);
});

test('task center edits update the collaboration and ordinary launch or handoff cannot replace the assigned target', async t => {
  const { options, service, actor, input } = await fixture(t);
  const { id } = await service.create(input, actor);
  const { collaboration } = service.detail(id);
  const teamCenter = createTaskCenter({
    database: options.database, tenantId: options.tenantId, history: { catalog: async () => ({ providers: [], sessions: [] }) }
  });
  const [part] = collaboration.participants;
  const update = (taskId: string, revision: number, content: string, status = 'ready') =>
    teamCenter.command({ action: 'update', taskId, revision, content, status }, actor);
  await update(collaboration.parentTaskId, 1, '将新搜索交付到测试环境');
  await update(part.taskId, 1, '负责搜索按钮');
  const changed = service.detail(id).collaboration;
  assert.equal(changed.goal, '将新搜索交付到测试环境');
  assert.equal(changed.participants[0].responsibility, '负责搜索按钮');
  assert.equal(changed.revision, collaboration.revision + 2);
  await assert.rejects(update(part.taskId, 2, 'a'.repeat(2001)), /2000/);
  await update(collaboration.parentTaskId, 2, changed.goal, 'completed');
  const completed = service.detail(id).collaboration;
  assert.equal(completed.taskStatus, 'completed');
  assert.equal(service.list().collaborations[0].taskStatus, 'completed');
  assert.equal(completed.revision, changed.revision + 1);
  const run = () => service.run(id, { requestId: randomUUID(), revision: service.detail(id).collaboration.revision, participantId: part.id }, actor);
  await assert.rejects(run(), /重新打开/);
  const tasks = (await teamCenter.snapshot()).tasks;
  assert.equal(tasks.find(task => task.id === collaboration.parentTaskId)?.title, input.title);
  assert.equal(tasks.find(task => task.id === part.taskId)?.title, `${input.title} · ${part.name}`);
  const generic = createCodexExecution({
    database: options.database, tenantId: options.tenantId, workspace: () => process.cwd(),
    environment: { LOCAL_EXECUTION_ENABLED: 'true' }, runnerFactory: () => ({
      async projects() { return [{ id: 'fixture', cwd: process.cwd() }]; }, close() {}
    })
  });
  t.after(() => generic.close());
  for (const task of tasks) {
    await assert.rejects(generic.execute({ taskId: task.id, revision: task.revision, projectId: 'fixture', deviceId: 'local' }, actor), /进入协作空间/);
    await assert.rejects(teamCenter.command({ action: 'handoff', taskId: task.id, revision: task.revision }, actor), /交接文档/);
  }
  assert.equal(options.database.readTaskCenter(options.tenantId).executions.length, 0);
  await update(collaboration.parentTaskId, 3, changed.goal);
  await update(part.taskId, 2, changed.participants[0].responsibility, 'completed');
  assert.equal(service.detail(id).collaboration.participants[0].taskStatus, 'completed');
  await assert.rejects(run(), /重新打开/);
  await update(part.taskId, 3, changed.participants[0].responsibility);
  const { executionId } = await run();
  assert.equal(service.detail(id).collaboration.participants[0].taskStatus, 'running');
  const accept = () => update(collaboration.parentTaskId, 4, changed.goal, 'completed');
  await assert.rejects(accept(), /待核对/);
  options.database.mutateTaskCenter(options.tenantId, data => {
    const job = data.executions.find(item => item.id === executionId)!;
    job.status = 'completed'; job.releaseStatus = 'failed';
  });
  await assert.rejects(accept(), /待核对/);
  options.database.mutateTaskCenter(options.tenantId, data => { data.executions[0].releaseStatus = 'released'; });
  await accept();
  assert.equal(service.detail(id).collaboration.taskStatus, 'completed');
});

test('directed Markdown preserves the reviewed text, versions, publication origin, and stays out of generic snapshots', async t => {
  const { key, options, service, input, actor } = await fixture(t);
  const { id } = await service.create(input, actor);
  const { collaboration } = service.detail(id);
  const [sender, recipient] = collaboration.participants;
  const doc = {
    requestId: randomUUID(), revision: collaboration.revision, fromParticipantId: sender.id, toParticipantId: recipient.id,
    title: '搜索约定', body: '    GET /search  \n\n返回列表\n'
  };
  const published = service.publish(id, doc, actor);
  assert.deepEqual(service.publish(id, doc, actor), published);
  const updated = service.detail(id).collaboration;
  assert.equal(updated.revision, collaboration.revision + 1);
  assert.equal(updated.documentCount, 1);
  assert.equal(updated.documents[0].id, published.id);
  assert.equal(updated.documents[0].body, doc.body);
  assert.equal(updated.documents[0].createdBy, actor.id);
  assert.equal('requestId' in updated.documents[0], false);
  assert.equal('documents' in service.list().collaborations[0], false);
  assert.throws(() => service.publish(id, { ...doc, title: '不同标题' }, actor), /请求标识/);
  assert.throws(() => service.publish(id, { ...doc, requestId: randomUUID() }, actor), /已更新/);
  assert.throws(() => service.publish(id, { ...doc, requestId: randomUUID(), revision: updated.revision, toParticipantId: sender.id }, actor), /不同/);
  assert.throws(() => service.publish(id, { ...doc, requestId: randomUUID(), revision: updated.revision, toParticipantId: randomUUID() }, actor), /属于/);
  const taskCenter = createTaskCenter({
    database: options.database, tenantId: options.tenantId, history: { catalog: async () => ({ providers: [], sessions: [] }) }
  });
  const snapshot = await taskCenter.snapshot();
  assert.equal('collaborations' in snapshot, false);
  const parent = snapshot.tasks.find(task => task.id === collaboration.parentTaskId)!;
  assert.match(parent.events[0].message, /界面.*接口.*搜索约定/);
  assert.equal(parent.status, 'ready');
  const reopened = openDatabase(key);
  try { assert.deepEqual(createCollaborations({ ...options, database: reopened }).detail(id).collaboration, updated); }
  finally { reopened.close(); }
});

test('document provenance must point to a successful run of the sender in this collaboration', async t => {
  const { options, service, actor, input } = await fixture(t);
  const { id } = await service.create(input, actor);
  const [sender, recipient] = service.detail(id).collaboration.participants;
  const { executionId } = await service.run(id, { requestId: randomUUID(), revision: 1, participantId: sender.id, documentIds: [] }, actor);
  const doc = {
    requestId: randomUUID(), revision: service.detail(id).collaboration.revision, title: '已验证接口', body: 'GET /search',
    fromParticipantId: sender.id, toParticipantId: recipient.id, sourceExecutionId: executionId
  };
  assert.throws(() => service.publish(id, doc, actor), /成功完成/);
  options.database.mutateTaskCenter(options.tenantId, data => {
    const job = data.executions.find(item => item.id === executionId)!;
    job.status = 'completed';
    job.output = '测试通过';
    job.releaseStatus = 'failed';
  });
  assert.throws(() => service.publish(id, doc, actor), /成功完成/);
  options.database.mutateTaskCenter(options.tenantId, data => { data.executions[0].releaseStatus = 'released'; });
  assert.throws(() => service.publish(id, { ...doc, fromParticipantId: recipient.id, toParticipantId: sender.id }, actor), /不属于/);
  const other = await service.create({ ...input, requestId: randomUUID() }, actor);
  const otherParts = service.detail(other.id).collaboration.participants;
  assert.throws(() => service.publish(other.id, { ...doc, revision: 1, fromParticipantId: otherParts[0].id, toParticipantId: otherParts[1].id }, actor), /不属于/);
  service.publish(id, doc, actor);
  const detail = service.detail(id).collaboration;
  assert.equal(detail.documents[0].sourceExecutionId, executionId);
  assert.equal(detail.runs[0].output, '测试通过');
  assert.equal('prompt' in detail.runs[0], false);
});

test('collaborations are isolated by team and require live work.execute permission for every mutation', async t => {
  const { options, service, actor, input, team, personal } = await fixture(t);
  const { id } = await service.create(input, actor);
  const { database } = options;
  const otherTeam = database.createWorkspace(personal, { name: '其他团队', requestId: randomUUID() });
  const foreign = createCollaborations({ ...options, tenantId: otherTeam.id });
  assert.deepEqual(foreign.list().collaborations, []);
  assert.throws(() => foreign.detail(id), /不存在/);
  const personalService = createCollaborations({ ...options, tenantId: personal.tenant.id });
  assert.throws(() => personalService.list(), /仅在团队空间/);
  await assert.rejects(personalService.create(input, { id: personal.user.id }), /仅在团队空间/);
  await assert.rejects(service.create(input, { id: personal.user.id }), /权限/);
  const account = await database.registerPersonal({ username: `viewer-${randomUUID()}`, password: 'collaboration-test-password' });
  const viewer = database.authenticateSession(account.token)!;
  const invitation = database.inviteWorkspaceMember(team, { role: 'viewer', username: viewer.user.username });
  database.acceptWorkspaceInvitation(viewer, invitation.id);
  const viewerActor = database.authenticateSession(database.switchWorkspace(viewer, { tenantId: options.tenantId }).token)!.user;
  const [sender, recipient] = service.detail(id).collaboration.participants;
  const doc = { requestId: randomUUID(), revision: 1, title: '说明', body: '约定', fromParticipantId: sender.id, toParticipantId: recipient.id };
  assert.throws(() => service.publish(id, doc, viewerActor), /权限/);
  await assert.rejects(service.create(input, viewerActor), /权限/);
  assert.equal(service.detail(id).collaboration.documents.length, 0);
});
