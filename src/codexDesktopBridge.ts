import net from 'node:net';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Environment } from './issueSources/types.js';

type JsonObject = Record<string, unknown>;
interface ProtocolReader {
  call(method: string, params: JsonObject): Promise<unknown>;
  close(): unknown;
}
interface RpcResponse extends JsonObject {
  type?: string; requestId?: string; resultType?: string; result?: JsonObject; error?: string; handledByClientId?: string;
}
interface BridgeParams extends JsonObject { threadId?: string; turnId?: string; input?: unknown[] }
interface ThreadItem extends JsonObject { id?: string; type?: string }
interface ThreadTurn extends JsonObject { id?: string; items?: ThreadItem[] }
interface ThreadReadResult { thread?: { path?: string; turns?: ThreadTurn[] } }
type ErrorLike = Error & { code?: string };
const record = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const asError = (value: unknown): ErrorLike => value instanceof Error ? value as ErrorLike : new Error(String(value));

// Experimental, versioned local client IPC. Never creates a router, changes socket
// permissions, impersonates an official client, or retries a submitted message.
export class CodexDesktopBridge extends EventEmitter {
  closed = false;
  private buffer = Buffer.alloc(0);
  private clientId = 'initializing-client';
  private owner = '';
  private pending = new Map<string, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private timer?: ReturnType<typeof setTimeout>;
  private turnId?: string;
  private failures = 0;
  constructor(private socket: net.Socket, private reader: ProtocolReader, private threadId: string) {
    super();
    socket.on('data', data => {
      try {
        this.buffer = Buffer.concat([this.buffer, data]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32LE(0);
          if (!length || length > 64 * 1024 * 1024) throw new Error('IPC 消息长度无效');
          if (this.buffer.length < length + 4) break;
          const message = record(JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'))) as RpcResponse;
          this.buffer = this.buffer.subarray(length + 4);
          if (message.type === 'response') {
            const requestId = message.requestId;
            const pending = typeof requestId === 'string' ? this.pending.get(requestId) : undefined;
            if (pending && requestId) { clearTimeout(pending.timer); this.pending.delete(requestId); pending.resolve(message); }
          } else if (message.type === 'broadcast' && message.method === 'client-status-changed' && record(message.params).clientId === this.owner && record(message.params).status === 'disconnected') {
            this.disconnected(new Error('会话拥有端已退出，请核对执行结果'));
          } else if (message.type === 'client-discovery-request') {
            this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
          }
        }
      } catch (error) { this.disconnected(error as Error); }
    });
    socket.on('error', error => this.disconnected(error));
    socket.on('close', () => this.disconnected(new Error('客户端 IPC 连接已关闭；请核对原会话，不要重复发送')));
  }
  static async connect(reader: ProtocolReader, threadId: string, environment: Environment = process.env): Promise<CodexDesktopBridge | null> {
    if (process.platform === 'win32') return null;
    const endpoint = path.join(environment.CODEX_HOME || path.join(homedir(), '.codex'), 'ipc', 'ipc.sock');
    try {
      const [directory, socketFile] = await Promise.all([lstat(path.dirname(endpoint)), lstat(endpoint)]);
      const uid = process.getuid?.();
      if (!directory.isDirectory() || !socketFile.isSocket() || directory.uid !== uid || socketFile.uid !== uid || (directory.mode & 0o077) || (socketFile.mode & 0o077)) throw new Error('客户端 IPC 路径权限不安全，已停止连接');
    } catch (caught: unknown) { const error = asError(caught); if (error.code === 'ENOENT') return null; throw error; }
    const socket = net.connect(endpoint), bridge = new CodexDesktopBridge(socket, reader, threadId);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('客户端 IPC 连接超时')), 3000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', error => { clearTimeout(timer); reject(error); });
      });
      const init = await bridge.rpc('initialize', { clientType: 'auto-workflow' }, 0);
      if (init.resultType !== 'success' || typeof init.result?.clientId !== 'string') throw new Error('客户端 IPC 初始化失败');
      bridge.clientId = init.result.clientId;
      const owner = await bridge.rpc('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1);
      if (owner.resultType !== 'success') {
        if (owner.error === 'no-client-found') { bridge.detach(); return null; }
        throw new Error(owner.error || '无法发现会话拥有者');
      }
      if (typeof owner.handledByClientId !== 'string') throw new Error('客户端 IPC 拥有者响应无效');
      bridge.owner = owner.handledByClientId;
      return bridge;
    } catch (error) { bridge.detach(); throw error; }
  }
  private send(message: unknown) {
    if (this.closed) throw new Error('客户端 IPC 连接已关闭');
    const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
    header.writeUInt32LE(body.length); this.socket.write(Buffer.concat([header, body]));
  }
  private rpc(method: string, params: JsonObject, version: number, targetClientId?: string): Promise<RpcResponse> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('客户端 IPC 响应超时，结果待核对；不会自动重发')); }, 15000);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send({ type: 'request', requestId, sourceClientId: this.clientId, method, params, version, targetClientId }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  async call(method: string, params: BridgeParams): Promise<unknown> {
    if (params.threadId !== this.threadId) throw new Error('IPC 会话标识不一致');
    if (method === 'thread/read') return this.reader.call(method, params);
    if (method === 'thread/unsubscribe') return { status: 'notSubscribed' };
    if (method === 'turn/start') {
      const response = await this.rpc('thread-follower-start-turn', {
        conversationId: this.threadId,
        turnStart: { request: { ...params, input: (params.input || []).map(item => ({ ...record(item), text_elements: [] })) }, context: { inheritThreadSettings: true } }
      }, 2, this.owner);
      // Any error after dispatch is ambiguous: never fall back to another writer.
      if (response.resultType !== 'success') throw new Error(response.error || '客户端提交结果未知');
      const result = record(response.result?.result), turn = record(result.turn);
      if (typeof turn.id !== 'string') throw new Error('客户端未返回执行标识，请核对原会话');
      this.turnId = turn.id;
      this.timer = setTimeout(() => void this.poll(), 500);
      return result;
    }
    if (method === 'turn/interrupt') {
      const response = await this.rpc('thread-follower-interrupt-turn', { conversationId: this.threadId, expectedTurnId: params.turnId, mode: 'user-stop' }, 4, this.owner);
      if (response.resultType !== 'success') throw new Error(response.error || '客户端停止请求失败');
      return {};
    }
    throw new Error(`客户端桥接不支持 ${method}`);
  }
  private async poll() {
    if (this.closed || !this.turnId) return;
    const turnId = this.turnId;
    try {
      const result = await this.reader.call('thread/read', { threadId: this.threadId, includeTurns: true }) as ThreadReadResult;
      if (this.closed) return;
      const turn = result.thread?.turns?.find(item => item.id === turnId);
      if (!turn) throw new Error('尚未读取到本轮持久记录');
      const output = turn.items?.filter(item => item.type === 'agentMessage').at(-1);
      if (output) this.emit('notification', { method: 'item/completed', params: { threadId: this.threadId, turnId: this.turnId, item: output } });
      // A separate app-server may report an actively persisted foreign turn as
      // interrupted. Only an explicit terminal rollout event confirms completion.
      const rolloutPath = result.thread?.path;
      if (typeof rolloutPath !== 'string') throw new Error('缺少原会话记录路径，无法核对结果');
      const terminal = await readDesktopTerminal(rolloutPath, turnId);
      this.failures = 0;
      if (terminal) {
        if (terminal.text) this.emit('notification', { method: 'item/completed', params: { threadId: this.threadId, turnId: this.turnId, item: { type: 'agentMessage', text: terminal.text } } });
        this.emit('notification', { method: 'turn/completed', params: { threadId: this.threadId, turn: { ...turn, status: terminal.status } } });
        return;
      }
    } catch (error) {
      if (++this.failures >= 3) { this.disconnected(error as Error); return; }
    }
    if (!this.closed) this.timer = setTimeout(() => void this.poll(), 2000);
  }
  private disconnected(error: Error) {
    if (this.closed) return;
    this.detach(error); this.emit('disconnected', error);
    void this.reader.close();
  }
  private detach(error = new Error('网页 IPC 连接已断开')) {
    this.closed = true; clearTimeout(this.timer); this.socket.destroy();
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  async close() { this.detach(); return this.reader.close(); }
}

// Read only the bounded tail of the native rollout path returned by thread/read.
// Never infer termination from another app-server's reconstructed runtime status.
export async function readDesktopTerminal(file: string, turnId: string): Promise<{ status: string; text?: string } | null> {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('缺少原会话记录路径，无法核对结果');
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size, start = Math.max(0, size - 4 * 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift();
    for (const line of lines.reverse()) {
      let parsed: unknown; try { parsed = JSON.parse(line); } catch { continue; }
      const row = record(parsed), event = record(row.payload);
      if (row.type !== 'event_msg' || event.turn_id !== turnId) continue;
      if (event.type === 'task_complete') return { status: 'completed', text: typeof event.last_agent_message === 'string' ? event.last_agent_message : '' };
      if (event.type === 'turn_aborted') return { status: 'interrupted' };
    }
    return null;
  } finally { await handle.close(); }
}
