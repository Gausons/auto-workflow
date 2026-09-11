import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

// Uses the installed Codex protocol and its existing login/configuration. No shell,
// no ephemeral threads, and no direct writes to Codex's database or rollout files.
export class CodexAppServer extends EventEmitter {
  sequence: any; pending: any; closed: any; child: any;

  constructor({ executable = 'codex', spawnProcess = spawn, environment = process.env }: any = {}) {
    super();
    this.sequence = 0; this.pending = new Map(); this.closed = false;
    this.child = spawnProcess(executable, ['app-server'], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', () => {}); // Never relay configuration or credentials in diagnostics.
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.method) { this.emit(message.id !== undefined ? 'request' : 'notification', message); return; }
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'Codex 请求失败'));
      else pending.resolve(message.result);
    });
    const ended = (error: any) => {
      if (this.closed) return; this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear(); this.emit('disconnected', error);
    };
    this.child.on('error', () => ended(new Error('无法启动 Codex，请检查客户端和 codex 命令是否已安装')));
    this.child.on('exit', () => ended(new Error('Codex 执行连接已关闭')));
    this.child.stdin.on('error', () => ended(new Error('Codex 执行连接已中断')));
  }
  send(message: any) { if (this.closed) throw new Error('Codex 连接未打开'); this.child.stdin.write(JSON.stringify(message) + '\n'); }
  call(method: any, params: any = {}, timeoutMs = 30000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 响应超时，执行结果待确认`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error: any) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    await this.call('initialize', { clientInfo: { name: 'bugflow_workbench', title: 'Agent 任务工作台', version: '0.4.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
    return this;
  }
  close() { this.child.kill('SIGTERM'); }
}
