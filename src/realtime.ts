import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { openDatabase } from './database.js';
import type { createTenantRuntime } from './tenantRuntime.js';
import { httpError, permissionForRealtimeChannel, permissionsFor } from './rbac.js';
import { realtimeMaxPayload, realtimeProtocol, type ExecutionFeedback, type RealtimeEvent, type RealtimeSubscription } from '../shared/realtime.js';

type Database = ReturnType<typeof openDatabase>;
type Principal = NonNullable<ReturnType<Database['authenticateSession']>>;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function createRealtime(server: Server, database: Database, runtimeFor: (principal: Principal['tenant']) => ReturnType<typeof createTenantRuntime>) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: realtimeMaxPayload, perMessageDeflate: false });
  let closing = false;
  const reject = (socket: Duplex, status: number) => {
    const body = JSON.stringify({ error: 'websocket_upgrade_failed', message: '实时连接升级失败' });
    socket.end(`HTTP/1.1 ${status} Error\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { reject(socket, 400); return; }
    if (closing) { reject(socket, 503); return; }
    if (url.pathname !== '/api/realtime') { reject(socket, 404); return; }
    if (url.search || req.headers['sec-websocket-protocol'] !== realtimeProtocol) { reject(socket, 400); return; }
    sockets.handleUpgrade(req, socket, head, ws => {
      let token = '', principal: Principal | null = null, subscription: RealtimeSubscription | null = null;
      let listener: { check(): void; close(): void } | undefined, reporting = false, lastPong = Date.now();
      const send = (value: unknown) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 1_000_000) { ws.close(1013, '实时连接积压，请重新同步'); return; }
        ws.send(JSON.stringify(value));
      };
      const fail = (error: unknown) => {
        const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
        const message = status < 500 && error instanceof Error ? error.message : '实时连接处理失败';
        send({ type: 'error', status, message }); ws.close(status === 401 ? 4401 : status === 403 ? 4403 : 4400, 'realtime request rejected');
      };
      const authorize = (): Principal => {
        const current = database.authenticateSession(token);
        if (!current) throw httpError(401, '请重新登录个人账号');
        if (!principal || current.tenant.id !== principal.tenant.id || current.user.id !== principal.user.id ||
          !permissionsFor(current.user.role).includes(permissionForRealtimeChannel(subscription?.channel) || '')) throw httpError(403, '实时连接权限已失效');
        const deviceId = subscription?.channel === 'device-control' ? subscription.deviceId : undefined;
        if (deviceId && database.readTaskCenter(current.tenant.id).devices.find(item => item.id === deviceId)?.owner !== current.user.id) throw httpError(403, '设备不属于此账号');
        return current;
      };
      const authTimeout = setTimeout(() => fail(httpError(401, '实时连接认证超时')), 5000);
      authTimeout.unref();
      const heartbeat = setInterval(() => {
        if (!subscription || ws.readyState !== WebSocket.OPEN) return;
        try {
          authorize(); listener?.check();
          if (Date.now() - lastPong > 45_000) { ws.terminate(); return; }
          send({ type: 'heartbeat' });
        } catch (error) { fail(error); }
      }, 15_000);
      heartbeat.unref();
      const cleanup = () => { clearTimeout(authTimeout); clearInterval(heartbeat); listener?.close(); };
      ws.on('close', cleanup); ws.on('error', () => { cleanup(); ws.terminate(); });
      ws.on('message', (raw, binary) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          if (binary) throw httpError(400, '实时连接只接受 JSON 文本');
          const text = raw.toString();
          if (!subscription && Buffer.byteLength(text) > 16_384) throw httpError(400, '实时认证消息过长');
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { throw httpError(400, '实时消息 JSON 无效'); }
          const input = record(parsed);
          if (!subscription) {
            if (input.type !== 'subscribe' || typeof input.token !== 'string' || input.token.length > 512) throw httpError(401, '请登录个人账号');
            token = input.token; principal = database.authenticateSession(token);
            if (!principal) throw httpError(401, '请登录个人账号');
            if (req.headers['x-tenant-id'] && req.headers['x-tenant-id'] !== principal.tenant.id || input.tenantId && input.tenantId !== principal.tenant.id) throw httpError(403, '登录会话不属于指定账号空间');
            const permission = permissionForRealtimeChannel(input.channel);
            if (!permission) throw httpError(404, '实时订阅不存在');
            if (!permissionsFor(principal.user.role).includes(permission)) {
              database.audit(principal.tenant.id, principal.user, 'access.denied', '/api/realtime', { channel: input.channel });
              throw httpError(403, '当前角色没有此操作权限');
            }
            if (input.channel === 'task-center') {
              if (!Number.isSafeInteger(input.since) || Number(input.since) < 0) throw httpError(400, '同步版本无效');
              subscription = { channel: 'task-center', since: Number(input.since) };
            } else {
              if (typeof input.deviceId !== 'string') throw httpError(400, '设备标识无效');
              subscription = { channel: 'device-control', deviceId: input.deviceId };
            }
            listener = runtimeFor(principal.tenant).subscribeRealtime(subscription, principal.user.id, (event: RealtimeEvent) => {
              try { authorize(); send(event); } catch (error) { fail(error); }
            }, fail);
            clearTimeout(authTimeout); send({ type: 'ready', channel: subscription.channel }); return;
          }
          const actor = authorize();
          if (input.type === 'pong') { lastPong = Date.now(); return; }
          if (input.type !== 'execution-report' || subscription.channel !== 'device-control') throw httpError(400, '实时消息类型无效');
          if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.id)) throw httpError(400, '回报标识无效');
          const payload = record(input.input);
          if (typeof payload.executionId !== 'string') throw httpError(400, '执行标识无效');
          const reply = (status: number, message?: string) => send({ type: 'report-ack', id: input.id, status, message });
          if (reporting) { reply(409, '上一条回报尚未处理'); return; }
          reporting = true;
          void runtimeFor(actor.tenant).reportRealtime(subscription.deviceId, payload as unknown as ExecutionFeedback, actor)
            .then(() => reply(200)).catch((error: unknown) => {
              const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
              reply(status, status < 500 && error instanceof Error ? error.message : '执行回报失败');
            }).finally(() => { reporting = false; });
        } catch (error) { fail(error); }
      });
    });
  });
  return {
    async close() {
      closing = true;
      await Promise.all([...sockets.clients].map(ws => new Promise<void>(resolve => {
        const timeout = setTimeout(() => { ws.terminate(); resolve(); }, 1000);
        ws.once('close', () => { clearTimeout(timeout); resolve(); }); ws.close(1012, '服务正在重启');
      })));
      await new Promise<void>(resolve => sockets.close(() => resolve()));
    }
  };
}
