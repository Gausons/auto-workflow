import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { CodexAppServer } from './codexAppServer.mjs';
import { httpError } from './rbac.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const timestamp = () => new Date().toISOString();
const active = new Set(['queued', 'launching', 'running', 'waiting', 'unknown']);
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
export async function openCodexThread(threadId) {
  if (!/^[a-f0-9-]{36}$/.test(threadId)) throw new Error('Codex 会话标识无效');
  const url = `codex://threads/${threadId}`;
  const command = process.platform === 'darwin' ? ['open', ['-g', url]] : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  await promisify(execFile)(command[0], command[1], { timeout: 10000 });
}
export function executionPrompt(task) {
  return [`任务：${task.title}`, ...Object.entries({ goal: '目标', constraints: '约束', decisions: '已确认结论', next: '下一步', files: '相关文件与版本' }).map(([key, label]) => `${label}：\n${task.context[key] || '未填写'}`), '请在指定项目中执行任务，完成后说明结果、验证情况和未完成事项。'].join('\n\n');
}

export class CodexRunner {
  constructor({ executable, environment, clientFactory = () => new CodexAppServer({ executable, environment }), onUpdate = () => {}, desktopOpener = openCodexThread } = {}) {
    this.clientFactory = clientFactory; this.onUpdate = onUpdate; this.jobs = new Map(); this.pendingRequests = new Map(); this.connecting = null; this.client = null;
    this.desktopOpener = desktopOpener;
  }
  publish(job, patch) { Object.assign(job, patch, { updatedAt: timestamp() }); this.onUpdate(structuredClone(job)); }
  async connect() {
    if (this.client && !this.client.closed) return this.client;
    if (!this.connecting) this.connecting = (async () => {
      const client = this.clientFactory();
      client.on('notification', message => this.notification(message));
      client.on('request', message => this.request(message));
      client.on('disconnected', () => {
        for (const job of this.jobs.values()) if (['launching', 'running', 'waiting'].includes(job.status)) this.publish(job, { status: 'unknown', message: '执行连接中断，请核对 Codex 会话；不会自动重复执行。', request: null });
        this.pendingRequests.clear();
      });
      try { await client.initialize(); this.client = client; return client; }
      catch (error) { client.close(); throw error; }
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async projects(allowedRoot) {
    const client = await this.connect();
    const account = await client.call('account/read', {});
    if (!account.account && account.requiresOpenaiAuth) throw new Error('请先在目标设备的 Codex 客户端登录');
    const root = await realpath(allowedRoot);
    const projects = []; let cursor;
    do {
      const result = await client.call('project/list', { ...(cursor ? { cursor } : {}) });
      for (const project of result.data || []) for (const entry of project.roots || []) {
        try { const cwd = await realpath(entry.path); if (inside(root, cwd)) projects.push({ id: project.id, name: project.name, cwd }); } catch { /* Removed project roots aren't executable. */ }
      }
      cursor = result.nextCursor;
    } while (cursor);
    return projects;
  }
  async start(job) {
    if (this.jobs.has(job.id)) return this.jobs.get(job.id);
    this.jobs.set(job.id, { ...job }); job = this.jobs.get(job.id);
    let creating = false;
    try {
      const client = await this.connect();
      this.publish(job, { status: 'launching', message: '正在创建 Codex 会话' });
      creating = true;
      const result = await client.call('thread/start', { cwd: job.cwd, projectId: job.projectId, ephemeral: false, serviceName: 'bugflow_workbench' });
      this.publish(job, { threadId: result.thread.id, message: 'Codex 会话已创建' });
      creating = false;
      await client.call('thread/name/set', { threadId: job.threadId, name: job.title });
      const turn = await client.call('turn/start', { threadId: job.threadId, input: [{ type: 'text', text: job.prompt }], clientUserMessageId: job.id });
      this.publish(job, { turnId: turn.turn.id, ...(job.status === 'launching' ? { status: 'running', message: 'Codex 正在执行' } : {}) });
      try { await this.desktopOpener(job.threadId); this.publish(job, { desktopOpened: true }); }
      catch { this.publish(job, { desktopOpened: false, desktopMessage: '无法自动打开客户端，请点击“在 Codex 中打开”查看会话。' }); }
    } catch (error) {
      this.publish(job, { status: job.threadId || creating ? 'unknown' : 'failed', message: error.message });
    }
    return job;
  }
  notification({ method, params }) {
    const job = [...this.jobs.values()].find(j => j.threadId === params?.threadId); if (!job) return;
    if (method === 'item/completed' && params.item?.type === 'agentMessage') this.publish(job, { output: String(params.item.text || '').slice(-24000) });
    if (method === 'turn/completed') {
      const state = { completed: 'completed', interrupted: 'interrupted', failed: 'failed' }[params.turn.status] || 'failed';
      this.publish(job, { status: state, turnId: params.turn.id, request: null, message: params.turn.error?.message || { completed: 'Codex 本轮执行完成', interrupted: '执行已停止', failed: 'Codex 执行失败' }[state] });
      this.pendingRequests.delete(job.id);
    }
  }
  request(message) {
    const job = [...this.jobs.values()].find(j => j.threadId === message.params?.threadId);
    if (!job || !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'].includes(message.method)) {
      this.client?.send({ id: message.id, error: { code: -32601, message: '工作台暂不支持此交互，请在 Codex 中继续处理' } }); return;
    }
    this.pendingRequests.set(job.id, message);
    this.publish(job, { status: 'waiting', request: { method: message.method, params: message.params }, message: message.method.endsWith('requestUserInput') ? 'Codex 等待你的回答' : 'Codex 等待操作确认' });
  }
  async respond(id, input) {
    const job = this.jobs.get(id), pending = this.pendingRequests.get(id);
    if (!job || !pending || !this.client || this.client.closed) throw httpError(409, '请求已失效，请刷新并查看 Codex 会话');
    let result;
    if (pending.method === 'item/tool/requestUserInput') {
      const answers = {};
      for (const question of pending.params.questions) {
        const value = input.answers?.[question.id];
        if (typeof value !== 'string' || !value.trim() || value.length > 12000) throw httpError(400, '请回答全部问题');
        answers[question.id] = { answers: [value] };
      }
      result = { answers };
    } else {
      if (!['accept', 'decline'].includes(input.decision)) throw httpError(400, '确认结果无效');
      result = { decision: input.decision };
    }
    this.client.send({ id: pending.id, result }); this.pendingRequests.delete(id);
    this.publish(job, { status: 'running', request: null, message: '已回复 Codex，继续执行' });
  }
  async stop(id) {
    const job = this.jobs.get(id);
    if (!job?.threadId || !job.turnId) throw httpError(409, '尚未获得执行标识，请稍后重试');
    await (await this.connect()).call('turn/interrupt', { threadId: job.threadId, turnId: job.turnId });
  }
  async reconcile(job) {
    if (!job.threadId) throw httpError(409, '尚无 Codex 会话标识，请检查客户端，确认未创建任务后再处理');
    const result = await (await this.connect()).call('thread/read', { threadId: job.threadId, includeTurns: true });
    const turn = job.turnId ? result.thread.turns.find(t => t.id === job.turnId) : result.thread.turns.at(-1);
    if (!turn) throw httpError(409, 'Codex 会话尚无执行记录，请在客户端核对');
    const status = { completed: 'completed', failed: 'failed', interrupted: 'interrupted' }[turn.status];
    if (!status) throw httpError(409, '该会话尚未结束，请在目标 Codex 中检查');
    this.publish(job, { status, turnId: turn.id, request: null, output: turn.items?.filter(i => i.type === 'agentMessage').at(-1)?.text || '', message: '已核对 Codex 执行记录' });
  }
  close() { this.client?.close(); }
}

export function recordExecution(data, job) {
      const saved = data.executions?.find(j => j.id === job.id); if (!saved) return;
      const previous = saved.status;
      Object.assign(saved, job);
      const task = data.tasks.find(t => t.id === saved.taskId); if (!task) return;
      if (job.threadId) {
        const id = createHash('sha256').update(`codex-execution:${job.threadId}`).digest('hex');
        let session = data.sessions.find(s => s.id === id);
        if (!session) { session = { id, source: 'codexExecution', deviceId: job.deviceId, agent: 'codex', agentLabel: 'Codex', nativeId: job.threadId, title: job.title, cwd: job.cwd, partial: true }; data.sessions.push(session); }
        Object.assign(session, { status: job.status, updatedAt: job.updatedAt, excerpt: `${job.prompt}\n\n${job.output || ''}` });
        if (!task.sessionIds.includes(id)) task.sessionIds.push(id);
      }
      const taskStatus = { launching: 'running', running: 'running', waiting: 'waiting', completed: 'completed', failed: 'error', unknown: 'error', interrupted: 'ready' }[job.status];
      if (taskStatus) task.status = taskStatus;
      if (previous !== job.status) { task.revision++; task.updatedAt = timestamp(); task.events.unshift({ id: randomUUID(), at: task.updatedAt, message: job.message }); }

}

export function createCodexExecution({ database, tenantId, workspace, environment = {}, runnerFactory } = {}) {
  let closing = false;
  const update = job => {
    if (!closing) database.mutateTaskCenter(tenantId, data => recordExecution(data, job));
  };
  const runner = runnerFactory ? runnerFactory(update) : new CodexRunner({ executable: environment.CODEX_EXECUTABLE || 'codex', environment: { ...process.env, ...environment }, onUpdate: update });
  database.mutateTaskCenter(tenantId, data => {
    data.executions ||= [];
    for (const job of data.executions) if (job.deviceId === 'local' && active.has(job.status)) {
      job.status = 'unknown'; job.request = null; job.message = '工作台已重启，请核对原 Codex 会话，避免重复执行';
      const task = data.tasks.find(t => t.id === job.taskId); if (task) { task.status = 'error'; task.revision++; }
    }
  });
  return {
    async targets() {
      let localError = null, projects = [];
      try { projects = (await runner.projects(workspace())).map(p => ({ ...p, deviceId: 'local', deviceName: '工作台所在设备', online: true })); }
      catch (error) { localError = error.message; }
      const devices = database.readTaskCenter(tenantId).devices;
      for (const d of devices) for (const p of d.codexProjects || []) projects.push({ ...p, deviceId: d.id, deviceName: d.name, online: Date.now() - Date.parse(d.lastSeen) < 90000 });
      return { projects, localError };
    },
    async execute(input) {
      const { projects } = await this.targets();
      const deviceId = input.deviceId || 'local';
      const project = projects.find(p => p.id === input.projectId && p.cwd === input.cwd && p.deviceId === deviceId);
      if (!project) throw httpError(400, '请选择当前组织工作目录内、已在 Codex 客户端添加的项目');
      const job = database.mutateTaskCenter(tenantId, data => {
        const task = data.tasks.find(t => t.id === input.taskId);
        if (!task) throw httpError(404, '任务不存在');
        if (task.revision !== input.revision) throw httpError(409, '任务已更新，请刷新后执行');
        if (task.status === 'running' || (data.executions || []).some(j => j.taskId === task.id && active.has(j.status))) throw httpError(409, '该任务已有执行，请先等待完成或停止，结果未知时请核对原会话');
        if (data.handoffs.some(h => h.taskId === task.id && h.mode === 'continue' && ['pending', 'received'].includes(h.status))) throw httpError(409, '请先取消原手动接续请求，再直接执行');
        const job = { id: randomUUID(), taskId: task.id, deviceId, projectId: project.id, cwd: project.cwd, title: task.title, prompt: executionPrompt(task), contextVersion: task.contextVersion, status: 'queued', createdAt: timestamp(), updatedAt: timestamp(), message: '已排队，准备交给 Codex', output: '', threadId: null, turnId: null };
        (data.executions ||= []).push(job); task.status = 'running'; task.revision++; task.updatedAt = timestamp();
        task.events.unshift({ id: randomUUID(), at: task.updatedAt, message: '已提交 Codex 执行' });
        return structuredClone(job);
      });
      if (job.deviceId === 'local') void runner.start(job); return { executionId: job.id };
    },
    async action(input, actor) {
      const job = database.readTaskCenter(tenantId).executions?.find(j => j.id === input.executionId);
      if (!job) throw httpError(404, '执行不存在');
      if (job.deviceId !== 'local') {
        if (['claim', 'report'].includes(input.action)) {
          return database.mutateTaskCenter(tenantId, data => {
            const saved = data.executions.find(j => j.id === job.id), device = data.devices.find(d => d.id === saved.deviceId);
            if (!actor || device?.owner !== actor.id) throw httpError(403, '只有该设备的连接器账号可以领取和回报执行');
            if (input.action === 'claim') {
              if (saved.status !== 'queued') throw httpError(409, '执行已被领取，不会重复执行');
              recordExecution(data, { ...saved, status: 'launching', message: '目标设备已领取，准备启动 Codex', updatedAt: timestamp() });
              return { job: structuredClone(saved) };
            }
            const report = input.report;
            if (!report || !['launching', 'running', 'waiting', 'completed', 'failed', 'interrupted', 'unknown'].includes(report.status)) throw httpError(400, '执行回报格式无效');
            if (saved.status === 'queued') throw httpError(409, '请先领取任务');
            if (report.threadId && !/^[a-f0-9-]{36}$/.test(report.threadId)) throw httpError(400, 'Codex 会话标识无效');
            if (saved.threadId && report.threadId && saved.threadId !== report.threadId) throw httpError(409, '不能替换已绑定的 Codex 会话');
            if (['completed', 'failed', 'interrupted'].includes(saved.status) && report.status !== saved.status) throw httpError(409, '执行已经结束');
            const patch = {};
            for (const key of ['threadId', 'turnId', 'message', 'output', 'desktopMessage']) if (report[key] !== undefined) {
              if (report[key] !== null && (typeof report[key] !== 'string' || report[key].length > (key === 'output' ? 24000 : 2000))) throw httpError(400, '回报字段无效');
              patch[key] = report[key];
            }
            if (JSON.stringify(report.request || null).length > 64000) throw httpError(400, '交互请求过大');
            recordExecution(data, { ...saved, ...patch, status: report.status, request: report.request || null, desktopOpened: Boolean(report.desktopOpened), updatedAt: timestamp() });
            if (saved.control?.id === input.controlAck) { saved.control = null; saved.controlError = input.controlError ? String(input.controlError).slice(0, 2000) : null; }
            return { executionId: saved.id };
          });
        }
        if (!['stop', 'respond', 'reconcile'].includes(input.action)) throw httpError(400, '操作无效');
        return database.mutateTaskCenter(tenantId, data => {
          const saved = data.executions.find(j => j.id === job.id);
          if (saved.control) throw httpError(409, '目标设备尚未处理上一条操作');
          if (input.action === 'respond' && saved.status !== 'waiting') throw httpError(409, 'Codex 当前没有待处理请求');
          saved.control = { id: randomUUID(), action: input.action, decision: input.decision, answers: input.answers };
          return { executionId: saved.id };
        });
      }
      if (input.action === 'stop') await runner.stop(job.id);
      else if (input.action === 'respond') await runner.respond(job.id, input);
      else if (input.action === 'reconcile') await runner.reconcile(job);
      else throw httpError(400, '操作无效');
      return { executionId: job.id };
    },
    close() { closing = true; runner.close(); }
  };
}
