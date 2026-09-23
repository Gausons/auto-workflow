import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rename, realpath, stat } from 'node:fs/promises';
import { CodexRunner, pickNativeDirectory } from './codexExecution.js';
import { AcpPreferredRunner, AcpTaskRunner, AgentRunnerSet, configuredAcpAgents } from './acpAgent.js';
import { contextPrompt, freezeContext, readContext, type ContextDelivery, type ContextEntry, type SessionContext } from './contextCompiler.js';
import { verifyBundle, verifySnapshot } from '@auto-workflow/context-engine';
import { detachSnapshot, restoreDetachedSnapshot, verifyDetachedManifest } from '@auto-workflow/context-engine/detached-bundle';
import { loadOrFreezeCapture } from '@auto-workflow/context-engine/capture-journal';
import type { AgentProject, ExecutionControl, PromptImageReference, RemoteContextHandoff, TaskCenterData } from '../public/taskTypes.js';

interface RemoteJob {
  id: string; status?: string; deviceId?: string; projectId?: string; cwd?: string; agent?: string;
  sessionId?: string | null; threadId?: string | null; output?: string;
  request?: unknown; message?: string; control?: ExecutionControl | null; controlAck?: string; controlError?: string | null;
  conversationId?: string; contextDigest?: string; remoteContext?: RemoteContextHandoff; userMessage?: string;
  contextSourceDeviceId?: string;
  contextTransferError?: string;
  directoryRequestId?: string;
  prompt?: string; contextMarkdownPath?: string; promptImages?: PromptImageReference[]; contextSourcePartial?: boolean;
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
  contextSource?: { catalog(): Promise<{ sessions: Array<{ id: string; sessionId?: string; agent: string; cwd: string }> }>; delivery: ContextDelivery };
}
type ErrorLike = Error & { code?: string };
const asError = (value: unknown): ErrorLike => value instanceof Error ? value as ErrorLike : new Error(String(value));
const isRemoteJob = (value: unknown): value is RemoteJob => Boolean(value && typeof value === 'object' && 'id' in value && typeof value.id === 'string');

// Journals the last known native thread before reconnecting. Uncertain launches
// are reported for review rather than retried and possibly duplicated.
export class RemoteCodexWorker {
  pending: Map<string, RemoteJob>; saved: Map<string, RemoteJob>; published: Set<string>; queue: Promise<void>; loaded: boolean; storageError: unknown; runner: RemoteRunner; update: (job: RemoteJob) => void;
  request: Request; directoryPicker: (workspace: string) => Promise<string>; deviceId: string; directory: string; workspace: string;
  contextSource?: WorkerOptions['contextSource'];

  constructor({ request, deviceId, directory, workspace, runnerFactory, directoryPicker = pickNativeDirectory, contextSource }: WorkerOptions) {
    this.request = request; this.deviceId = deviceId; this.directory = directory; this.workspace = workspace; this.directoryPicker = directoryPicker; this.contextSource = contextSource;
    this.pending = new Map(); this.saved = new Map(); this.published = new Set(); this.queue = Promise.resolve(); this.loaded = false;
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
  async originalContext(meta: RemoteContextHandoff, conversationId: string, sourceId: string) {
    if (!/^[a-f0-9]{64}$/.test(meta.sourceFreezeId)) throw new Error('远端来源快照标识无效');
    const root = path.join(this.directory, 'context');
    const file = path.join(root, `source-${meta.sourceFreezeId}.json`);
    const load = async () => {
      const saved = JSON.parse(await readFile(file, 'utf8')) as { sourceNativeId?: string; sourceAgent?: string; context?: SessionContext };
      if (saved.sourceNativeId !== meta.sourceNativeId || saved.sourceAgent !== meta.sourceAgent) throw new Error('远端冻结来源校验失败');
      try { return verifySnapshot(saved.context); } catch { throw new Error('远端冻结来源校验失败'); }
    };
    try { return await load(); }
    catch (caught: unknown) { if ((caught as NodeJS.ErrnoException).code !== 'ENOENT') throw caught; }
    if (meta.sourceFreezeId !== conversationId) throw new Error('远端冻结来源已丢失，不能改读变动后的原会话');
    if (!this.contextSource) throw new Error('远端历史服务不可用');
    const original = await readContext(this.contextSource.delivery, sourceId);
    if (!original.entries.length) throw new Error('远端原始会话没有可读取的记录');
    const context = freezeContext(original.entries, [sourceId], original.partial);
    await mkdir(root, { recursive: true, mode: 0o700 });
    try { await writeFile(file, JSON.stringify({ sourceNativeId: meta.sourceNativeId, sourceAgent: meta.sourceAgent, context }), { flag: 'wx', mode: 0o600 }); }
    catch (caught: unknown) { if ((caught as NodeJS.ErrnoException).code !== 'EEXIST') throw caught; return load(); }
    return context;
  }
  async sourceSnapshot(job: RemoteJob) {
    const meta = job.remoteContext;
    if (!meta || !this.contextSource || !job.conversationId || !job.userMessage || !job.contextDigest ||
      meta.sourceDeviceId !== this.deviceId || meta.contextDigest !== job.contextDigest || !/^[a-f0-9]{64}$/.test(meta.contextDigest)) throw new Error('远端交接元数据无效');
    const catalog = await this.contextSource.catalog();
    const source = catalog.sessions.find(item => item.agent === meta.sourceAgent && item.cwd === (meta.sourceCwd || job.cwd) && (item.sessionId || item.id) === meta.sourceNativeId);
    if (!source && meta.sourceFreezeId === job.conversationId) throw new Error('远端原始会话不存在，无法生成完整交接文件');
    const original = await this.originalContext(meta, job.conversationId, source?.id || '');
    const inherited: ContextEntry[] = [];
    for (let offset = 0, total = 1; offset < total;) {
      const page = await this.request('GET', undefined, `/api/conversations/${job.conversationId}/inherited?offset=${offset}`) as { messages?: ContextEntry[]; total?: number; digest?: string };
      if (page.digest !== meta.contextDigest || !Number.isSafeInteger(page.total) || page.total! < 0 || page.total! > 100000 || !Array.isArray(page.messages)) throw new Error('远端交接快照校验失败');
      total = page.total!;
      if (!page.messages.length && offset < total) throw new Error('远端交接快照缺少记录');
      for (const entry of page.messages) {
        if (!entry || !['user', 'assistant', 'tool_call', 'tool_result'].includes(entry.role) || typeof entry.text !== 'string' || typeof entry.source !== 'string') throw new Error('远端交接记录格式无效');
        inherited.push(entry);
      }
      offset += page.messages.length;
    }
    const supplemental = inherited.filter(entry => entry.source !== meta.sourceSessionId);
    return freezeContext([...original.entries, ...supplemental], [...original.sources, meta.sourceSessionId, ...new Set(supplemental.map(entry => entry.source))], original.partial);
  }
  async outboundSnapshot(job: RemoteJob) {
    const identity = createHash('sha256').update(JSON.stringify([job.id, job.conversationId, job.deviceId,
      job.contextSourceDeviceId, job.contextDigest, job.remoteContext])).digest('hex');
    return loadOrFreezeCapture(path.join(this.directory, 'context'), job.id, identity, () => this.sourceSnapshot(job));
  }
  async prepareContext(job: RemoteJob) {
    if (!job.conversationId || !job.userMessage) return job;
    let snapshot: SessionContext;
    if (job.contextSourceDeviceId && job.contextSourceDeviceId !== this.deviceId) {
      const result = await this.request('GET', undefined, `/api/conversations/${job.conversationId}/transfer?executionId=${job.id}&deviceId=${this.deviceId}&format=manifest-v3`) as { ready?: boolean; context?: SessionContext; bundle?: unknown; manifest?: unknown };
      if (!result.ready || (!result.context && !result.bundle && !result.manifest)) throw new Error('跨设备交接包尚未送达');
      try {
        if (result.manifest) {
          const manifest = verifyDetachedManifest(result.manifest);
          const objects = new Map<string, Uint8Array>();
          for (const item of manifest.objects) {
            const raw = await this.request('GET', undefined, `/api/conversations/${job.conversationId}/transfer/objects/${item.digest}?executionId=${job.id}&deviceId=${this.deviceId}`);
            if (!(raw instanceof Uint8Array)) throw new Error('交接对象响应不是原始字节');
            objects.set(item.digest, raw);
          }
          snapshot = restoreDetachedSnapshot(manifest, objects);
        } else snapshot = result.bundle ? verifyBundle(result.bundle).snapshot : verifySnapshot(result.context);
      }
      catch { throw new Error('跨设备交接包校验失败'); }
    } else if (job.remoteContext) snapshot = await this.sourceSnapshot(job);
    else return job;
    const compiled = await contextPrompt(snapshot, job.userMessage, path.join(this.directory, 'context'));
    return { ...job, prompt: compiled.prompt, promptImages: compiled.images, contextMarkdownPath: compiled.markdownPath, contextSourcePartial: snapshot.partial };
  }
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
    for (const job of snapshot.executions.filter(candidate => candidate.contextSourceDeviceId === this.deviceId && candidate.deviceId !== this.deviceId && candidate.status === 'queued' && candidate.remoteContext && !this.published.has(candidate.id))) {
      if (!job.conversationId) continue;
      try {
        const context = await this.outboundSnapshot(job);
        const detached = detachSnapshot(context);
        const probe = await this.request('POST', { executionId: job.id, deviceId: this.deviceId, probe: detached.manifest },
          `/api/conversations/${job.conversationId}/transfer`) as { missingObjects?: unknown };
        const known = new Set(detached.objects.map(item => item.digest));
        if (!Array.isArray(probe?.missingObjects) || probe.missingObjects.some(item => typeof item !== 'string' || !known.has(item)) ||
            new Set(probe.missingObjects).size !== probe.missingObjects.length) throw new Error('交接对象查询响应无效');
        const missing = new Set(probe.missingObjects as string[]);
        for (const item of detached.objects.filter(item => missing.has(item.digest))) await this.request('POST', item.data,
          `/api/conversations/${job.conversationId}/transfer/objects/${item.digest}?executionId=${job.id}&deviceId=${this.deviceId}&mimeType=${encodeURIComponent(item.mimeType)}`);
        await this.request('POST', { executionId: job.id, deviceId: this.deviceId, manifest: detached.manifest }, `/api/conversations/${job.conversationId}/transfer`);
      } catch (caught: unknown) {
        const transient = caught as ErrorLike & { status?: number };
        if (typeof transient.status === 'number' && (transient.status >= 500 || [408, 429].includes(transient.status)) ||
            ['AbortError', 'TimeoutError', 'TypeError'].includes(transient.name) ||
            ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'].includes(transient.code || '')) throw caught;
        await this.request('POST', { executionId: job.id, deviceId: this.deviceId, failure: asError(caught).message.slice(0, 2000) }, `/api/conversations/${job.conversationId}/transfer`);
      }
      this.published.add(job.id);
    }
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
        if (job.contextSourceDeviceId && job.contextSourceDeviceId !== this.deviceId && !job.contextTransferError) {
          const transfer = await this.request('GET', undefined, `/api/conversations/${job.conversationId}/transfer?executionId=${job.id}&deviceId=${this.deviceId}&readyOnly=1&format=manifest-v3`) as { ready?: boolean };
          if (!transfer.ready) continue;
        }
        const projects = await this.projects();
        const project = projects.find(item => item.id === job.projectId);
        const selection = snapshot.directoryRequests?.find(item => item.id === job.directoryRequestId);
        if (!project || (project.cwd !== job.cwd && (!selection || selection.status !== 'completed' || selection.deviceId !== this.deviceId || selection.projectId !== project.id || selection.cwd !== job.cwd))) throw new Error('待执行项目不在本机允许的工作目录内');
        if (!job.cwd || !(await stat(await realpath(job.cwd))).isDirectory()) throw new Error('目标工作目录已不可用');
        const claimedResult = await this.request('POST', { action: 'claim', executionId: job.id }, '/api/task-center/execution-action') as { job?: unknown };
        if (!isRemoteJob(claimedResult.job)) throw new Error('领取执行返回无效');
        const claimed = claimedResult.job;
        // Persist the claim before invoking thread/start. A crash here remains unknown.
        this.saved.set(job.id, claimed); await this.persist(claimed);
        if (claimed.contextTransferError) {
          this.update({ ...claimed, status: 'failed', request: null, message: `跨设备交接失败：${claimed.contextTransferError}` });
          continue;
        }
        let prepared: RemoteJob;
        try { prepared = await this.prepareContext(claimed); await this.persist(prepared); this.saved.set(job.id, prepared); }
        catch (caught: unknown) {
          this.update({ ...claimed, status: 'failed', request: null, message: `远端交接文件准备失败：${asError(caught).message}` });
          continue;
        }
        await this.runner.start(prepared);
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
