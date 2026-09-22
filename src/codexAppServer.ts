import { resolveCodexExecutable } from './codexExecutable.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Environment } from './issueSources/types.js';

interface AppServerOptions { executable?: string; spawnProcess?: typeof spawn; environment?: Environment }
interface ProtocolMessage { id?: number; method?: string; result?: unknown; error?: { message?: string; code?: unknown } }
interface PendingCall { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

// Uses the installed Codex protocol and its existing login/configuration. No shell,
// no ephemeral threads, and no direct writes to Codex's database or rollout files.
export class CodexAppServer extends EventEmitter {
  sequence: number; pending: Map<number, PendingCall>; closed: boolean; child: ChildProcessWithoutNullStreams;

  constructor({ executable = 'codex', spawnProcess = spawn, environment = process.env }: AppServerOptions = {}) {
    super();
    this.sequence = 0; this.pending = new Map(); this.closed = false;
    const command = resolveCodexExecutable({ executable, environment });
    this.child = spawnProcess(command, ['app-server'], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', () => {}); // Never relay configuration or credentials in diagnostics.
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      let message: ProtocolMessage; try { message = JSON.parse(line) as ProtocolMessage; } catch { return; }
      if (message.method) { this.emit(message.id !== undefined ? 'request' : 'notification', message); return; }
      const id = message.id;
      if (typeof id !== 'number') return;
      const pending = this.pending.get(id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'Codex 请求失败'), { code: message.error.code }));
      else pending.resolve(message.result);
    });
    const ended = (error: Error) => {
      if (this.closed) return; this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear(); this.emit('disconnected', error);
    };
    this.child.on('error', (error: NodeJS.ErrnoException) => ended(Object.assign(new Error(`无法启动 Codex（${error.code || 'spawn error'}）：${command}。${error.code === 'EACCES' ? '请检查文件执行权限。' : '请检查 CODEX_EXECUTABLE 或客户端安装路径。'}`), { code: error.code })));
    this.child.on('exit', () => ended(new Error('Codex 执行连接已关闭')));
    this.child.stdin.on('error', () => ended(new Error('Codex 执行连接已中断')));
  }
  send(message: unknown) { if (this.closed) throw new Error('Codex 连接未打开'); this.child.stdin.write(JSON.stringify(message) + '\n'); }
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 响应超时，执行结果待确认`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error: unknown) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    await this.call('initialize', { clientInfo: { name: 'bugflow_workbench', title: 'Agent 任务工作台', version: '0.4.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
    return this;
  }
  close(): Promise<boolean> {
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolve => {
      const forced = setTimeout(() => this.child.kill('SIGKILL'), 2000);
      const timeout = setTimeout(() => finish(false), 5000);
      const finish = (exited: boolean) => { clearTimeout(forced); clearTimeout(timeout); this.child.removeListener('exit', onExit); resolve(exited); };
      const onExit = () => finish(true);
      this.child.once('exit', onExit);
      this.child.kill('SIGTERM');
    });
  }
}
