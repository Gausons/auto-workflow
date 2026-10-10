import type { IncomingMessage, ServerResponse } from 'node:http';
import type { openDatabase } from './database.js';
import { httpError, permissionsFor } from './rbac.js';
import type { TaskCenterData } from '../shared/taskTypes.js';

// Notifications contain no commands. Claims and durable receipts remain the
// authority for execution; reconnects always reconcile the current device state.
function controlKey(data: TaskCenterData, deviceId: string) {
  return JSON.stringify([
    data.executions.filter(job => job.deviceId === deviceId || job.contextSourceDeviceId === deviceId)
      .filter(job => job.status === 'queued' || job.deviceId === deviceId && job.control)
      .map(job => [job.id, job.status === 'queued', job.control?.id, job.contextTransferError, job.contextId]),
    data.directoryRequests?.filter(item => item.deviceId === deviceId && item.status === 'pending').map(item => item.id),
    data.gitRequests?.filter(item => item.deviceId === deviceId && ['pending', 'running'].includes(item.status)).map(item => [item.id, item.status])
  ]);
}

export function createDeviceControl(database: ReturnType<typeof openDatabase>, tenantId: string) {
  const connections = new Set<ServerResponse>();
  const snapshot = (params: URLSearchParams, userId: string): TaskCenterData => {
    const deviceId = params.get('deviceId');
    if (!deviceId || deviceId === 'local' || !/^[a-zA-Z0-9_-]{1,80}$/.test(deviceId) || params.getAll('deviceId').length !== 1) throw httpError(400, '设备标识无效');
    const data = database.readTaskCenter(tenantId);
    const device = data.devices.find(item => item.id === deviceId);
    if (!device) throw httpError(404, '设备不存在');
    if (device.owner !== userId) throw httpError(403, '只有目标设备连接器账号可以读取控制状态');
    return { syncVersion: data.syncVersion || 0, tasks: [], sessions: [], devices: [device],
      executions: (data.executions || []).filter(job => job.deviceId === deviceId || job.contextSourceDeviceId === deviceId),
      handoffs: [],
      directoryRequests: data.directoryRequests?.filter(item => item.deviceId === deviceId),
      gitRequests: data.gitRequests?.filter(item => item.deviceId === deviceId) };
  };
  return {
    snapshot,
    subscribe(params: URLSearchParams, userId: string, send: (version: number) => void, onError: (error: unknown) => void) {
      let key: string | undefined;
      const check = () => {
        const data = snapshot(params, userId), next = controlKey(data, data.devices[0].id);
        if (key !== next) { key = next; send(data.syncVersion || 0); }
      };
      const unsubscribe = database.subscribeTaskCenter(tenantId, () => { try { check(); } catch (error) { onError(error); } });
      try { check(); } catch (error) { unsubscribe(); throw error; }
      return { check, close: unsubscribe };
    },
    close() { for (const response of connections) response.end(); },
    async serve(req: IncomingMessage, res: ServerResponse, params: URLSearchParams, userId: string) {
      const initial = snapshot(params, userId), deviceId = initial.devices[0].id;
      const token = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '')?.[1];
      let key: string | undefined;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders(); connections.add(res);
      const publish = () => {
        if (res.destroyed || res.writableEnded) return;
        try {
          const principal = database.authenticateSession(token);
          if (!principal || principal.tenant.id !== tenantId || principal.user.id !== userId || !permissionsFor(principal.user.role).includes('work.execute')) { res.end(); return; }
          const data = snapshot(params, userId), next = controlKey(data, deviceId);
          if (next === key) return;
          key = next;
          if (!res.write(`event: device-control\ndata: ${JSON.stringify({ version: data.syncVersion })}\n\n`)) res.end();
        } catch { res.end(); }
      };
      const unsubscribe = database.subscribeTaskCenter(tenantId, publish);
      const timer = setInterval(() => {
        publish(); // Includes changes committed by another server process.
        if (!res.destroyed && !res.writableEnded && !res.write(': keep-alive\n\n')) res.end();
      }, 15_000);
      timer.unref();
      await new Promise<void>(resolve => {
        const close = () => {
          clearInterval(timer); unsubscribe(); connections.delete(res);
          req.off('aborted', close); res.off('close', close); resolve();
        };
        req.once('aborted', close); res.once('close', close);
        if (res.destroyed) close(); else publish();
      });
    }
  };
}
