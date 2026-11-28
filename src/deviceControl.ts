import type { IncomingMessage, ServerResponse } from 'node:http';
import type { openDatabase } from './database.js';
import { sharedDeviceScopes } from './sharedDeviceWork.js';
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
  const snapshot = (params: URLSearchParams, userId: string, boundDevice?: string): TaskCenterData => {
    const deviceId = params.get('deviceId');
    if (!deviceId || deviceId === 'local' || !/^[a-zA-Z0-9_-]{1,80}$/.test(deviceId) || params.getAll('deviceId').length !== 1) throw httpError(400, '设备标识无效');
    const data = database.readTaskCenter(tenantId);
    const device = data.devices.find(item => item.id === deviceId);
    if (!device) throw httpError(404, '设备不存在');
    if (device.owner !== userId) throw httpError(403, '只有目标设备连接器账号可以读取控制状态');
    const state: TaskCenterData = { syncVersion: data.syncVersion || 0, tasks: [], sessions: [], devices: [device],
      executions: [], handoffs: [], directoryRequests: [], gitRequests: [] };
    const append = (center: TaskCenterData) => {
      state.executions.push(...(center.executions || []).filter(job => job.deviceId === deviceId || job.contextSourceDeviceId === deviceId));
      state.directoryRequests!.push(...(center.directoryRequests || []).filter(r => r.deviceId === deviceId));
      state.gitRequests!.push(...(center.gitRequests || []).filter(r => r.deviceId === deviceId).map(r => ({ ...r, id: r.workerId || r.id })));
    };
    if (device.sharedFromPersonal) throw httpError(403, '共享设备使用个人空间的连接器领取任务');
    append(data);
    if (boundDevice !== undefined && boundDevice !== deviceId) return state;
    for (const scope of sharedDeviceScopes(database, tenantId, userId, deviceId)) {
      if (scope.devices.has(deviceId)) append(scope.data);
    }
    return state;
  };
  return {
    snapshot,
    syncSnapshot(userId: string, boundDevice?: string): TaskCenterData {
      const data = database.readTaskCenter(tenantId);
      const devices = data.devices.filter(device => device.owner === userId && !device.sharedFromPersonal)
        .map(device => ({ ...device, online: Date.now() - Date.parse(device.lastSeen) < 90_000 }));
      const owned = new Set(devices.map(device => device.id));
      const handoffs = data.handoffs.filter(handoff => owned.has(handoff.deviceId));
      const targets = new Set(handoffs.map(handoff => handoff.targetSessionId));
      // Sync needs the native session ID to save reference packets. Collaboration
      // prompts are delivered through the selected device's control endpoint.
      const sessions = data.sessions.filter(session => owned.has(session.deviceId) && targets.has(session.id))
        .map(({ id, nativeId, deviceId, agent, title, cwd, updatedAt }) => ({ id, nativeId, deviceId, agent, title, cwd, updatedAt }));
      for (const scope of sharedDeviceScopes(database, tenantId, userId, boundDevice)) {
        const packets = scope.data.handoffs.filter(h => scope.devices.has(h.deviceId));
        handoffs.push(...packets);
        const referenced = new Set(packets.map(h => h.targetSessionId));
        for (const s of scope.data.sessions) if (scope.devices.has(s.deviceId) && referenced.has(s.id)) {
          sessions.push({ id: s.id, nativeId: s.nativeId, deviceId: s.deviceId, agent: s.agent, title: s.title, cwd: s.cwd, updatedAt: s.updatedAt });
        }
      }
      return { syncVersion: data.syncVersion, tasks: [], devices, sessions, handoffs,
        executions: (data.executions || []).filter(job => !job.collaborationId && (owned.has(job.deviceId) || owned.has(job.contextSourceDeviceId || ''))),
        directoryRequests: data.directoryRequests?.filter(item => owned.has(item.deviceId)),
        gitRequests: data.gitRequests?.filter(item => owned.has(item.deviceId)) };
    },
    subscribe(params: URLSearchParams, userId: string, send: (version: number) => void, onError: (error: unknown) => void, boundDevice?: string) {
      let key: string | undefined;
      const check = () => {
        const data = snapshot(params, userId, boundDevice), next = controlKey(data, data.devices[0].id);
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
          const data = snapshot(params, userId, principal.connectorDeviceId), next = controlKey(data, deviceId);
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
