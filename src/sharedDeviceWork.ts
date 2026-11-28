import type { openDatabase } from './database.js';
import type { TaskCenterData } from '../shared/taskTypes.js';
import { httpError } from './rbac.js';

type Database = ReturnType<typeof openDatabase>;
export type DeviceWorkKind = 'execution' | 'report' | 'directory' | 'git' | 'handoff' | 'sourceContext' | 'transferSource' | 'transferTarget';

export function sharedDeviceScopes(database: Database, origin: string, accountId: string, deviceId?: string) {
  const teams = new Map<string, { tenantId: string; memberId: string; devices: Set<string>; data: TaskCenterData }>();
  for (const share of database.workspaceDevices.destinations(origin, accountId, deviceId)) {
    let team = teams.get(share.tenantId);
    if (!team) {
      team = { tenantId: share.tenantId, memberId: share.memberId, devices: new Set(), data: database.readTaskCenter(share.tenantId) };
      teams.set(share.tenantId, team);
    }
    if (team.data.devices.some(d => d.sharedFromPersonal && d.id === share.deviceId && d.owner === share.memberId)) team.devices.add(share.deviceId);
  }
  return [...teams.values()];
}

export function deviceWorkTarget(data: TaskCenterData, kind: DeviceWorkKind, id: string) {
  switch (kind) {
    case 'git': return data.gitRequests?.find(r => (r.workerId || r.id) === id)?.deviceId;
    case 'directory': return data.directoryRequests?.find(r => r.id === id)?.deviceId;
    case 'handoff': return data.handoffs.find(r => r.id === id)?.deviceId;
    case 'sourceContext': return data.executions?.find(r => r.conversationId === id && r.remoteContext && r.contextSourceDeviceId)?.contextSourceDeviceId;
    case 'transferSource': return data.executions?.find(r => r.id === id)?.contextSourceDeviceId;
    default: return data.executions?.find(r => r.id === id)?.deviceId;
  }
}

// Old connectors address work by its receipt ID. Resolve only records assigned
// to an explicitly shared device, never a caller-supplied team or member ID.
export function sharedWorkRoute(database: Database, origin: string, accountId: string, kind: DeviceWorkKind, id: unknown, deviceId?: string) {
  if (typeof id !== 'string' || !id) return;
  if (kind === 'report') {
    // A durable receipt can be replayed after a restart or a membership change.
    // It can only update the exact job previously claimed through this grant.
    const matches = database.workspaceDevices.receiptDestinations(origin, accountId).filter(route => {
      if (deviceId !== undefined && route.deviceId !== deviceId) return false;
      return database.readTaskCenter(route.tenantId).executions?.some(job => job.id === id &&
        job.deviceId === route.deviceId && job.sharedDeviceMemberId === route.memberId);
    });
    if (!matches.length) return;
    if (matches.length > 1 || deviceWorkTarget(database.readTaskCenter(origin), kind, id)) throw httpError(409, '执行标识冲突，请核对原记录');
    return matches[0];
  }
  const scopes = sharedDeviceScopes(database, origin, accountId, deviceId);
  const matches = scopes.filter(scope => {
    const target = deviceWorkTarget(scope.data, kind, id);
    return target && scope.devices.has(target);
  });
  if (!matches.length) return;
  if (matches.length !== 1 || deviceWorkTarget(database.readTaskCenter(origin), kind, id)) throw httpError(409, '设备请求标识冲突，请核对原记录');
  const scope = matches[0];
  return { tenantId: scope.tenantId, memberId: scope.memberId, deviceId: deviceWorkTarget(scope.data, kind, id)! };
}
