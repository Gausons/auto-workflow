import * as acp from '@agentclientprotocol/sdk';
import { EventEmitter } from 'node:events';
import { AcpTaskRunner } from '../src/acpAgent.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createGroupChats } from '../src/groupChats.js';
import { createCodexExecution, recordExecution } from '../src/codexExecution.js';
import type { AgentProject, Execution } from '../shared/taskTypes.js';
import { applyTaskCenterDelta, taskCenterDelta } from '../shared/taskCenterSync.js';
import { openDatabase } from '../scripts/testing/database.js';

async function fixture(t: TestContext) {
  const key = randomUUID(), database = openDatabase(key);
  database.createTenant({ id: 'default', token: 'test-group-chat-token'.repeat(3) });
  const account = await database.registerPersonal({ username: `chat-${randomUUID()}`, password: 'group-chat-test-password-2026' });
  const principal = database.authenticateSession(account.token)!;
  const { id: tenantId } = database.createWorkspace(principal, { name: '群聊团队', requestId: randomUUID() });
  const team = database.switchWorkspace({ ...principal, token: account.token }, { tenantId });
  const memberPrincipal = database.authenticateSession(team.token)!;
  const actor = { id: memberPrincipal.user.id };
  let projects: AgentProject[] = ['codex', 'claude'].map(agent => ({ id: agent, agent, protocol: 'acp', deviceId: 'local', cwd: process.cwd(), online: true }));
  const launched: Execution[] = [];
  const execution = {
    targets: async () => ({ projects }),
    launch(job: Execution) { launched.push(job); },
    async action(input: { executionId: string }) {
      database.mutateTaskCenter(tenantId, data => {
        const job = data.executions.find(item => item.id === input.executionId)!;
        recordExecution(data, { ...job, status: 'interrupted', message: '已停止' });
      });
    }
  };
  const options = { database, tenantId, execution }, service = createGroupChats(options);
  const input = { requestId: randomUUID(), name: '方案讨论', participants: projects.map((project, index) => ({ name: `同事 ${index + 1}`, deviceId: 'local', projectId: project.id, responsibility: index ? '评估风险' : '提出方案' })) };
  const { id } = await service.create(input, actor);
  const send = (message = '请分析实现方案') => service.send(id, { requestId: randomUUID(), message, revision: service.detail(id).room.revision }, actor);
  const finish = (status: Execution['status'] = 'completed', output = '先确定边界，再实现') => database.mutateTaskCenter(tenantId, data => {
    const job = data.executions.at(-1)!; recordExecution(data, { ...job, status, output });
  });
  t.after(() => { service.close(); database.close(); });
  return { key, database, tenantId, principal, actor, execution, service, options, input, id, send, finish, launched, setProjects(value: AgentProject[]) { projects = value; } };
}

test('group chat persists an idempotent round and agents read preceding replies in order', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.create(f.input, f.actor)).id, f.id);
  await assert.rejects(f.service.create({ ...f.input, name: '另一讨论' }, f.actor), /请求标识/);
  const before = f.database.readTaskCenter(f.tenantId);
  const input = { requestId: randomUUID(), message: '请分析实现方案', revision: f.service.detail(f.id).room.revision };
  f.service.send(f.id, input, f.actor); f.service.send(f.id, input, f.actor);
  assert.equal(f.service.detail(f.id).room.messages.length, 3);
  assert.throws(() => f.service.send(f.id, { ...input, message: '不同消息' }, f.actor), /另一条消息/);
  assert.throws(() => f.send(), /当前讨论/);
  await Promise.all([f.service.progress(), f.service.progress()]);
  assert.equal(f.launched.length, 1);
  assert.match(f.launched[0].prompt, /请分析实现方案/);
  assert.match(f.launched[0].prompt, /不可信的聊天记录/);
  const version = f.database.readTaskCenter(f.tenantId).syncVersion;
  await f.service.progress();
  assert.equal(f.launched.length, 1);
  assert.equal(f.database.readTaskCenter(f.tenantId).syncVersion, version, 'unchanged execution does not write another journal entry');
  f.finish(); await f.service.progress();
  assert.equal(f.launched.length, 2);
  assert.match(f.launched[1].prompt, /先确定边界，再实现/);
  assert.equal(f.launched[1].agent, 'claude');
  f.finish('completed', '同意方案，补充安全校验'); await f.service.progress();
  assert.equal(f.service.detail(f.id).room.round?.status, 'completed');
  const changes = f.database.readTaskCenterChanges(f.tenantId, before.syncVersion!);
  const replayed = applyTaskCenterDelta(before, taskCenterDelta(changes.data, before.syncVersion!, changes.changes, changes.reset));
  assert.deepEqual(replayed.groupChatRooms, changes.data.groupChatRooms);
  const reopened = openDatabase(f.key);
  try { assert.equal(reopened.readTaskCenter(f.tenantId).groupChatRooms?.[0].messages.at(-1)?.text, '同意方案，补充安全校验'); } finally { reopened.close(); }
  assert.throws(() => f.service.send(f.id, { requestId: randomUUID(), message: '继续', revision: 1 }, f.actor), /已更新/);
  f.send('继续讨论'); await f.service.progress(); assert.equal(f.launched.length, 3);
});

test('unknown and failed executions block later speakers and never replay a submitted instruction', async t => {
  const f = await fixture(t);
  f.send(); await f.service.progress(); f.finish('unknown', '提交状态不确定'); await f.service.progress();
  assert.equal(f.service.detail(f.id).room.round?.status, 'blocked');
  assert.equal(f.service.detail(f.id).room.messages.at(-1)?.status, 'stopped');
  const recovered = createGroupChats(f.options);
  await recovered.progress(); await recovered.progress(); assert.equal(f.launched.length, 1);
  assert.throws(() => recovered.send(f.id, { requestId: randomUUID(), message: '重试', revision: recovered.detail(f.id).room.revision }, f.actor), /结果未知/);
  f.finish('completed', '核对确认已完成的观点'); f.send('核对后开始新话题'); await f.service.progress(); assert.equal(f.launched.length, 2);
  assert.match(f.launched[1].prompt, /核对确认已完成的观点/);
  f.finish('failed'); await f.service.progress(); assert.equal(f.service.detail(f.id).room.round?.status, 'blocked');
  await f.service.progress(); assert.equal(f.launched.length, 2);
});

test('stop cancels the current execution and all future speakers without repeating it', async t => {
  const f = await fixture(t); f.send(); await f.service.progress();
  const revision = f.service.detail(f.id).room.revision;
  await f.service.stop(f.id, { revision }, f.actor); await f.service.stop(f.id, { revision }, f.actor);
  await f.service.progress(); assert.equal(f.launched.length, 1);
  assert.equal(f.service.detail(f.id).room.round?.status, 'stopped');
  assert.ok(f.service.detail(f.id).room.messages.filter(message => message.role === 'agent').every(message => message.status === 'stopped'));
  f.send('新话题'); await f.service.progress(); assert.equal(f.launched.length, 2);
});

test('unavailable targets and revoked membership halt a saved round before another launch', async t => {
  const f = await fixture(t); f.send(); f.setProjects([]); await f.service.progress();
  assert.equal(f.launched.length, 0); assert.equal(f.service.detail(f.id).room.round?.status, 'blocked');
  assert.match(f.service.detail(f.id).room.messages[1].detail || '', /不可用/);
  f.send();
  const member = f.database.getUser(f.tenantId, f.actor.id)!;
  // A current owner can demote themselves only after another enabled owner exists.
  const account = await f.database.registerPersonal({ username: `second-${randomUUID()}`, password: 'group-chat-test-password-2026' });
  const other = f.database.authenticateSession(account.token)!;
  const invite = f.database.inviteWorkspaceMember({ ...f.principal, tenant: { id: f.tenantId }, user: member }, { username: other.user.username, role: 'operator' });
  f.database.acceptWorkspaceInvitation(other, invite.id);
  const second = f.database.workspaceMembers({ ...f.principal, tenant: { id: f.tenantId }, user: member }).members.find(item => item.username === other.user.username)!;
  f.database.updateUser(f.tenantId, String(second.id), { role: 'owner', expectedUpdatedAt: second.updatedAt }, member);
  f.database.updateUser(f.tenantId, member.id, { role: 'viewer', expectedUpdatedAt: member.updatedAt }, member);
  await f.service.progress(); assert.equal(f.launched.length, 0); assert.equal(f.service.detail(f.id).room.round?.status, 'blocked');
  assert.throws(() => f.send(), /没有发起/);
});

test('restarting the execution service preserves uncertain local results without launching a replacement', async t => {
  const f = await fixture(t); f.send(); await f.service.progress();
  const execution = createCodexExecution({ database: f.database, tenantId: f.tenantId, workspace: () => process.cwd(), runnerFactory: () => ({ close() {} }) });
  execution.close(); await f.service.progress();
  assert.equal(f.service.detail(f.id).room.messages[1].status, 'unknown');
  assert.equal(f.launched.length, 1); assert.throws(() => f.send(), /结果未知/);
});

test('a launch exception and a missing execution remain uncertain and cannot submit another round', async t => {
  const f = await fixture(t);
  f.execution.launch = () => { throw new Error('uncertain launch'); };
  f.send(); await f.service.progress(); await f.service.progress();
  assert.equal(f.service.detail(f.id).room.messages[1].status, 'unknown');
  assert.throws(() => f.send(), /结果未知/);
  f.database.mutateTaskCenter(f.tenantId, data => { data.executions = []; });
  assert.equal(f.service.detail(f.id).room.messages[1].status, 'unknown');
  assert.throws(() => f.send(), /结果未知/);
});

test('a failed stop preserves the submitted execution and blocks another round', async t => {
  const f = await fixture(t); f.send(); await f.service.progress();
  f.execution.action = async () => { throw new Error('停止失败'); };
  await assert.rejects(f.service.stop(f.id, { revision: f.service.detail(f.id).room.revision }, f.actor), /停止失败/);
  assert.equal(f.service.detail(f.id).room.round?.status, 'stopped');
  assert.equal(f.service.detail(f.id).room.messages[1].status, 'running');
  assert.throws(() => f.send(), /当前讨论/);
  await f.service.progress(); assert.equal(f.launched.length, 1);
});

test('shutdown during target discovery does not commit or launch another execution', async t => {
  const f = await fixture(t); f.send();
  let finishTargets: (value: { projects: AgentProject[] }) => void = () => {};
  f.execution.targets = () => new Promise(resolve => { finishTargets = resolve; });
  const pending = f.service.progress();
  f.service.close(); finishTargets({ projects: [{ id: 'codex', agent: 'codex', deviceId: 'local', cwd: process.cwd(), online: true }] });
  await pending;
  assert.equal(f.launched.length, 0);
  assert.equal(f.database.readTaskCenter(f.tenantId).executions?.length || 0, 0);
});

test('stop follows a stable round identity despite output updates and cannot stop a later round', async t => {
  const f = await fixture(t); f.send();
  const room = f.service.detail(f.id).room;
  await f.service.progress();
  assert.notEqual(f.service.detail(f.id).room.revision, room.revision);
  await f.service.stop(f.id, { revision: room.revision, roundId: room.round!.id }, f.actor);
  f.send('另一轮');
  await assert.rejects(f.service.stop(f.id, { revision: room.revision, roundId: room.round!.id }, f.actor), /轮次已变化/);
  assert.equal(f.service.detail(f.id).room.round?.status, 'running');
});


test('each local participant executes in its selected canonical directory and rejects unavailable paths', async t => {
  const f = await fixture(t), root = await mkdtemp(path.join(tmpdir(), 'chat-cwd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  await mkdir(first); await mkdir(second);
  const input = { ...f.input, requestId: randomUUID(), participants: f.input.participants.map((participant, index) => ({ ...participant, cwd: index ? second : first })) };
  const { id } = await f.service.create(input, f.actor);
  assert.deepEqual(f.service.detail(id).room.participants.map(item => item.cwd), [await realpath(first), await realpath(second)]);
  assert.equal((await f.service.create(input, f.actor)).id, id);
  await assert.rejects(f.service.create({ ...input, participants: input.participants.map(item => ({ ...item, cwd: second })) }, f.actor), /请求标识/);
  for (const cwd of ['', false, {}, 'x'.repeat(2001), '/missing-group-chat-directory', first + '\0']) await assert.rejects(f.service.create({ ...input, requestId: randomUUID(), participants: input.participants.map(item => ({ ...item, cwd })) }, f.actor), /工作目录/);
  f.service.send(id, { message: '讨论目录中的项目', requestId: randomUUID(), revision: 1 }, f.actor);
  await Promise.all([f.service.progress(), f.service.progress()]);
  assert.equal(f.launched.at(-1)?.cwd, await realpath(first));
  f.finish(); await f.service.progress(); assert.equal(f.launched.at(-1)?.cwd, await realpath(second));
  f.finish(); await f.service.progress();
  f.service.send(id, { message: '继续', requestId: randomUUID(), revision: f.service.detail(id).room.revision }, f.actor);
  await rm(first, { recursive: true }); await f.service.progress();
  assert.equal(f.service.detail(id).room.round?.status, 'blocked'); assert.equal(f.launched.length, 2);
});

test('remote selected directories bind grants to the tenant, creator, device, project and completed result', async t => {
  const f = await fixture(t);
  f.setProjects(['codex', 'claude'].map(agent => ({ id: agent, agent, deviceId: 'remote', cwd: '/repo', online: true })));
  const grantId = randomUUID();
  const grant = { id: grantId, deviceId: 'remote', projectId: 'codex', requestedBy: f.actor.id, status: 'completed' as const, cwd: '/selected/project', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const input = { ...f.input, requestId: randomUUID(), participants: f.input.participants.map((participant, index) => ({ ...participant, deviceId: 'remote', cwd: index ? '/repo/subdir' : '/selected/project', ...(index ? {} : { directoryRequestId: grantId }) })) };
  await assert.rejects(f.service.create(input, f.actor), /确认此工作目录/);
  f.database.mutateTaskCenter(f.principal.tenant.id, data => { data.directoryRequests = [grant]; });
  await assert.rejects(f.service.create(input, f.actor), /确认此工作目录/);
  for (const invalid of [{ ...grant, requestedBy: 'another-member' }, { ...grant, deviceId: 'other-device' }, { ...grant, projectId: 'claude' }, { ...grant, status: 'pending' as const }, { ...grant, cwd: '/different' }]) {
    f.database.mutateTaskCenter(f.tenantId, data => { data.directoryRequests = [invalid]; });
    await assert.rejects(f.service.create(input, f.actor), /确认此工作目录/);
  }
  f.database.mutateTaskCenter(f.tenantId, data => { data.directoryRequests = [grant]; });
  const { id } = await f.service.create(input, f.actor);
  assert.equal((await f.service.create(input, f.actor)).id, id);
  for (const cwd of ['/repo/../secret', '/repo-other', 'relative/path', '/selected/project/other']) await assert.rejects(f.service.create({ ...input, requestId: randomUUID(), participants: input.participants.map((participant, index) => index ? participant : { ...participant, cwd }) }, f.actor), /确认此工作目录/);
  f.service.send(id, { message: '远端项目讨论', requestId: randomUUID(), revision: 1 }, f.actor);
  await f.service.progress(); assert.equal(f.launched.at(-1)?.cwd, grant.cwd); assert.equal(f.launched.at(-1)?.directoryRequestId, grantId);
  f.finish(); await f.service.progress(); assert.equal(f.launched.at(-1)?.cwd, '/repo/subdir');
  f.finish(); await f.service.progress();
  f.service.send(id, { message: '再讨论', requestId: randomUUID(), revision: f.service.detail(id).room.revision }, f.actor);
  f.database.mutateTaskCenter(f.tenantId, data => { data.directoryRequests = []; });
  await f.service.progress(); assert.equal(f.launched.length, 2); assert.equal(f.service.detail(id).room.round?.status, 'blocked');
  assert.match(f.service.detail(id).room.messages.at(-2)?.detail || '', /确认此工作目录/);
});


test('an Agent authentication rejection halts the group round, persists a failure and permits only a manually started new round', async t => {
  const f = await fixture(t);
  let authenticated = false, prompts = 0;
  class GroupAuthenticationConnection extends EventEmitter {
    closed = false; promptStarted = false;
    async initialize() {}
    async newSession() { return { sessionId: 'auth-group-session' }; }
    async configure() { return []; }
    async prompt() { prompts++; this.promptStarted = true; if (!authenticated) throw acp.RequestError.authRequired(); return { stopReason: 'end_turn' }; }
    close() { this.closed = true; }
  }
  const runner = new AcpTaskRunner({ agent: 'codex', environment: {}, connectionFactory: () => new GroupAuthenticationConnection(), onUpdate: job => f.database.mutateTaskCenter(f.tenantId, data => recordExecution(data, job)) });
  t.after(() => runner.close());
  f.execution.launch = job => { void runner.start({ ...job }); };
  f.send(); await f.service.progress();
  await new Promise(resolve => setImmediate(resolve));
  await f.service.progress();
  const room = f.service.detail(f.id).room;
  assert.equal(room.round?.status, 'blocked'); assert.equal(room.messages[1].status, 'failed'); assert.equal(room.messages[2].status, 'stopped');
  assert.match(room.messages[1].detail || '', /需要认证/);
  const saved = openDatabase(f.key);
  try { assert.equal(saved.readTaskCenter(f.tenantId).executions.at(-1)?.status, 'failed'); } finally { saved.close(); }
  await f.service.progress(); assert.equal(prompts, 1);
  authenticated = true;
  await f.service.progress(); assert.equal(prompts, 1, 'login must not automatically replay the rejected prompt');
  f.send('认证完成，重新讨论'); await f.service.progress(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(prompts, 2);
});
