import path from 'node:path';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { CodexRunner, pickNativeDirectory } from './codexExecution.js';
import { AcpPreferredRunner, AcpTaskRunner, AgentRunnerSet, configuredAcpAgents } from './acpAgent.js';
import type { AgentProject, ExecutionControl, TaskCenterData } from '../public/taskTypes.js';

interface RemoteJob {
  id: string; status?: string; deviceId?: string; projectId?: string; cwd?: string; agent?: string;
  request?: unknown; message?: string; control?: ExecutionControl | null; controlAck?: string; controlError?: string | null;
}
type Request = (method: string, body?: unknown, endpoint?: string) => unknown;
interface RemoteRunner {
  projects(root: string): Promise<AgentProject[]>;
  start(job: RemoteJob): Promise<unknown> | unknown;
  respond(id: string, input: unknown): Promise<unknown>;
  stop(id: string): Promise<unknown>;
  reconcile(job: RemoteJob): Promise<unknown>;
  close(): void;
}
interface WorkerOptions {
  request: Request;
  deviceId: string;
  directory: string;
  workspace: string;
  runnerFactory?: (update: (job: RemoteJob) => void) => unknown;
  directoryPicker?: (workspace: string) => Promise<string>;
}
type ErrorLike = Error & { code?: string };
const asError = (value: unknown): ErrorLike => value instanceof Error ? value as ErrorLike : new Error(String(value));
const isRemoteJob = (value: unknown): value is RemoteJob => Boolean(value && typeof value === 'object' && 'id' in value && typeof value.id === 'string');

// Journals the last known native thread before reconnecting. Uncertain launches
// are reported for review rather than retried and possibly duplicated.
export class RemoteCodexWorker {
  pending: Map<string, RemoteJob>; saved: Map<string, RemoteJob>; queue: Promise<void>; loaded: boolean; storageError: unknown; runner: RemoteRunner; update: (job: RemoteJob) => void;
  request: Request; directoryPicker: (workspace: string) => Promise<string>; deviceId: string; directory: string; workspace: string;

  constructor({ request, deviceId, directory, workspace, runnerFactory, directoryPicker = pickNativeDirectory }: WorkerOptions) {
    this.request = request; this.deviceId = deviceId; this.directory = directory; this.workspace = workspace; this.directoryPicker = directoryPicker;
    this.pending = new Map(); this.saved = new Map(); this.queue = Promise.resolve(); this.loaded = false;
    const update = (job: RemoteJob) => {
      this.saved.set(job.id, structuredClone(job)); this.pending.set(job.id, structuredClone(job));
      this.queue = this.queue.then(() => this.persist(job)).catch((error: unknown) => { this.storageError = error; });
    };
    this.runner = (runnerFactory ? runnerFactory(update) : (() => {
      const fallback = new CodexRunner({ executable: process.env.CODEX_EXECUTABLE || 'codex', onUpdate: update, desktopOpener: async () => {} });
      const codex = new AcpTaskRunner({ agent: 'codex', environment: process.env, onUpdate: update,
        threadNamer: async (threadId: string, name: string) => (await fallback.connect()).call('thread/name/set', { threadId, name }) });
      const entries: Array<[string, AcpPreferredRunner | AcpTaskRunner]> = [['codex', new AcpPreferredRunner({ primary: codex, fallback })]];
      for (const agent of configuredAcpAgents(process.env)) {
        if (agent !== 'codex') entries.push([agent, new AcpTaskRunner({ agent, environment: process.env, onUpdate: update })]);
      }
      return new AgentRunnerSet(entries);
    })()) as RemoteRunner;
    this.update = update;
  }
  async persist(job: RemoteJob) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, job.id + '.json');
    await writeFile(file + '.pending', JSON.stringify(job), { mode: 0o600 });
    await rename(file + '.pending', file);
  }
  async projects() { return this.runner.projects(this.workspace); }
  async flush() {
    await this.queue; if (this.storageError) throw this.storageError;
    for (const [id, report] of this.pending) {
      await this.request('POST', { action: 'report', executionId: id, report, controlAck: report.controlAck, controlError: report.controlError }, '/api/task-center/execution-action');
      if (this.pending.get(id) === report) this.pending.delete(id);
    }
  }
  async sync() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!this.loaded) {
      for (const file of await readdir(this.directory)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
        const parsed: unknown = JSON.parse(await readFile(path.join(this.directory, file), 'utf8'));
        if (!isRemoteJob(parsed)) continue;
        const job = parsed;
        if (job.id + '.json' !== file || job.deviceId !== this.deviceId) continue;
        if (typeof job.status === 'string' && ['launching', 'running', 'waiting'].includes(job.status)) { job.status = 'unknown'; job.request = null; job.message = '连接器已重启，请核对原 Agent 会话，不会重复执行'; }
        this.saved.set(job.id, job); this.pending.set(job.id, job);
      }
      this.loaded = true;
    }
    await this.flush();
    const snapshot = await this.request('GET') as TaskCenterData;
    for (const selection of (snapshot.directoryRequests || []).filter(item => item.deviceId === this.deviceId && item.status === 'pending').slice(0, 1)) {
      await this.request('POST', { action: 'claim', requestId: selection.id }, '/api/task-center/directory-action');
      try {
        const cwd = await this.directoryPicker(this.workspace);
        await this.request('POST', { action: 'report', requestId: selection.id, cwd }, '/api/task-center/directory-action');
      } catch (caught: unknown) {
        const error = asError(caught);
        await this.request('POST', { action: 'report', requestId: selection.id, cancelled: error.code === 'DIRECTORY_PICKER_CANCELLED', message: error.message }, '/api/task-center/directory-action');
      }
    }
    for (const job of snapshot.executions.filter(candidate => candidate.deviceId === this.deviceId)) {
      if (!/^[a-f0-9-]{36}$/.test(job.id)) throw new Error('执行标识无效');
      if (job.status === 'queued' && !this.saved.has(job.id)) {
        const projects = await this.projects();
        if (!projects.some(project => project.id === job.projectId && project.cwd === job.cwd)) throw new Error('待执行项目不在本机允许的工作目录内');
        const claimedResult = await this.request('POST', { action: 'claim', executionId: job.id }, '/api/task-center/execution-action') as { job?: unknown };
        if (!isRemoteJob(claimedResult.job)) throw new Error('领取执行返回无效');
        const claimed = claimedResult.job;
        // Persist the claim before invoking thread/start. A crash here remains unknown.
        this.saved.set(job.id, claimed); await this.persist(claimed);
        await this.runner.start(claimed);
      } else if (['launching', 'running', 'waiting'].includes(job.status) && !this.saved.has(job.id)) {
        this.update({ ...job, status: 'unknown', request: null, message: '本机没有这次执行的运行记录，请核对 Agent 会话' });
      }
      const current = this.saved.get(job.id);
      if (job.control && current && current.controlAck !== job.control.id) {
        try {
          if (job.control.action === 'stop') await this.runner.stop(job.id);
          else if (job.control.action === 'respond') await this.runner.respond(job.id, job.control);
          else if (job.control.action === 'reconcile') await this.runner.reconcile(current);
          this.update({ ...current, ...this.saved.get(job.id), controlAck: job.control.id, controlError: null });
        } catch (caught: unknown) { this.update({ ...this.saved.get(job.id)!, controlAck: job.control.id, controlError: asError(caught).message }); }
      }
    }
    await this.flush();
  }
  close() { this.runner.close(); }
}
