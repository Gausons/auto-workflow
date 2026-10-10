import type { IncomingMessage, ServerResponse } from 'node:http';
import type { openDatabase } from './database.js';
import { httpError, permissionsFor } from './rbac.js';
import type { TaskCenterChangeIds } from '../shared/taskCenterSync.js';

export function taskCenterSince(params: URLSearchParams): number {
  const raw = params.get('since') ?? '0', since = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(since) || since < 0 || params.getAll('since').length > 1) throw httpError(400, '同步版本无效');
  return since;
}

export function createTaskCenterStream(database: ReturnType<typeof openDatabase>, tenantId: string) {
  const connections = new Set<ServerResponse>();
  return {
    subscribe(since: number, send: (update: import('../shared/taskCenterSync.js').TaskCenterUpdate) => void) {
      let delivered = since;
      const publish = (version: number, changes?: TaskCenterChangeIds) => {
        if (version === delivered) return;
        const reset = version !== delivered + 1 || !changes;
        delivered = version; send({ version, changes, ...(reset && { reset: true }) });
      };
      const unsubscribe = database.subscribeTaskCenter(tenantId, publish);
      try { publish(database.readTaskCenter(tenantId).syncVersion || 0); }
      catch (error) { unsubscribe(); throw error; }
      return { check: () => publish(database.readTaskCenter(tenantId).syncVersion || 0), close: unsubscribe };
    },
    close() { for (const response of connections) response.end(); },
    async serve(req: IncomingMessage, res: ServerResponse, params: URLSearchParams) {
      let delivered = taskCenterSince(params);
      const token = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '')?.[1];
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
      });
      res.flushHeaders();
      connections.add(res);
      const publish = (version: number, changes?: TaskCenterChangeIds) => {
        if (res.destroyed || res.writableEnded || version === delivered) return;
        const reset = version !== delivered + 1 || !changes;
        delivered = version;
        if (!res.write(`id: ${version}\nevent: task-center\ndata: ${JSON.stringify({ version, changes, ...(reset && { reset: true }) })}\n\n`)) res.end();
      };
      const unsubscribe = database.subscribeTaskCenter(tenantId, publish);
      const keepAlive = setInterval(() => {
        try {
          const principal = database.authenticateSession(token);
          if (!principal || principal.tenant.id !== tenantId || !permissionsFor(principal.user.role).includes('read')) { res.end(); return; }
          // Also detect commits from another process, whose in-memory listeners are separate.
          publish(database.readTaskCenter(tenantId).syncVersion || 0);
          if (!res.destroyed && !res.writableEnded && !res.write(': keep-alive\n\n')) res.end();
        } catch { res.destroy(); }
      }, 15_000);
      keepAlive.unref();
      await new Promise<void>(resolve => {
        const close = () => {
          clearInterval(keepAlive); unsubscribe(); connections.delete(res);
          req.off('aborted', close); res.off('close', close); resolve();
        };
        req.once('aborted', close); res.once('close', close);
        if (res.destroyed) close();
        else {
          try { publish(database.readTaskCenter(tenantId).syncVersion || 0); }
          catch (error) { close(); res.destroy(); throw error; }
        }
      });
    }
  };
}
