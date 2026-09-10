import path from 'node:path';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { CodexRunner } from './codexExecution.mjs';

// Journals the last known native thread before reconnecting. Uncertain launches
// are reported for review rather than retried and possibly duplicated.
export class RemoteCodexWorker {
  constructor({ request, deviceId, directory, workspace, runnerFactory }) {
    Object.assign(this, { request, deviceId, directory, workspace });
    this.pending = new Map(); this.saved = new Map(); this.queue = Promise.resolve(); this.loaded = false;
    const update = job => {
      this.saved.set(job.id, structuredClone(job)); this.pending.set(job.id, structuredClone(job));
      this.queue = this.queue.then(() => this.persist(job)).catch(error => { this.storageError = error; });
    };
    this.runner = runnerFactory ? runnerFactory(update) : new CodexRunner({ executable: process.env.CODEX_EXECUTABLE || 'codex', onUpdate: update });
    this.update = update;
  }
  async persist(job) {
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
        const job = JSON.parse(await readFile(path.join(this.directory, file), 'utf8'));
        if (job.id + '.json' !== file || job.deviceId !== this.deviceId) continue;
        if (['launching', 'running', 'waiting'].includes(job.status)) { job.status = 'unknown'; job.request = null; job.message = '连接器已重启，请核对原 Codex 会话，不会重复执行'; }
        this.saved.set(job.id, job); this.pending.set(job.id, job);
      }
      this.loaded = true;
    }
    await this.flush();
    const snapshot = await this.request('GET');
    for (const job of (snapshot.executions || []).filter(j => j.deviceId === this.deviceId)) {
      if (!/^[a-f0-9-]{36}$/.test(job.id)) throw new Error('执行标识无效');
      if (job.status === 'queued' && !this.saved.has(job.id)) {
        const projects = await this.projects();
        if (!projects.some(p => p.id === job.projectId && p.cwd === job.cwd)) throw new Error('待执行项目不在本机允许的工作目录内');
        const { job: claimed } = await this.request('POST', { action: 'claim', executionId: job.id }, '/api/task-center/execution-action');
        // Persist the claim before invoking thread/start. A crash here remains unknown.
        this.saved.set(job.id, claimed); await this.persist(claimed);
        await this.runner.start(claimed);
      } else if (['launching', 'running', 'waiting'].includes(job.status) && !this.saved.has(job.id)) {
        this.update({ ...job, status: 'unknown', request: null, message: '本机没有这次执行的运行记录，请核对 Codex 会话' });
      }
      const current = this.saved.get(job.id);
      if (job.control && current && current.controlAck !== job.control.id) {
        try {
          if (job.control.action === 'stop') await this.runner.stop(job.id);
          else if (job.control.action === 'respond') await this.runner.respond(job.id, job.control);
          else if (job.control.action === 'reconcile') await this.runner.reconcile(current);
          this.update({ ...this.saved.get(job.id), controlAck: job.control.id, controlError: null });
        } catch (error) { this.update({ ...this.saved.get(job.id), controlAck: job.control.id, controlError: error.message }); }
      }
    }
    await this.flush();
  }
  close() { this.runner.close(); }
}
