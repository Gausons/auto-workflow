import type { Device, TaskCenterData } from '../shared/taskTypes.js';
import { httpError } from './rbac.js';
import type { Connection } from './storage/connection.js';

export interface SharedDeviceRoute { tenantId: string; memberId: string; deviceId: string }
interface Identity { tenant: { id: string }; user: { id: string; username?: string }; scope?: string }
type Mutate = <T>(tenantId: string, update: (data: TaskCenterData) => T) => T;

const membership = `FROM workspace_memberships m
  JOIN organization_users a ON a.id = m.account_id
  JOIN organization_users u ON u.tenant_id = m.tenant_id AND u.id = m.member_id`;
const enabled = "a.enabled = 1 AND u.enabled = 1 AND a.role <> 'viewer' AND u.role <> 'viewer'";
const grant = 'JOIN workspace_device_shares s ON s.account_id = m.account_id AND s.tenant_id = m.tenant_id';

type Audit = (tenantId: string, actor: Identity['user'], action: string, deviceId: string) => void;

function deviceHasPendingWork(data: TaskCenterData, id: string) {
  const unfinished = (data.executions || []).some(job => (job.deviceId === id || job.contextSourceDeviceId === id) &&
    (['queued', 'launching', 'running', 'waiting', 'unknown'].includes(job.status) || job.releaseStatus === 'releasing' || job.releaseStatus === 'failed'));
  return unfinished || data.directoryRequests?.some(r => r.deviceId === id && r.status === 'selecting') ||
    data.gitRequests?.some(r => r.deviceId === id && r.status === 'running' && Date.now() - Date.parse(r.updatedAt) < 120_000) ||
    data.handoffs.some(h => h.deviceId === id && h.status === 'pending');
}

export function createWorkspaceDevices(db: Connection, readDevices: (tenantId: string) => Device[], mutate: Mutate, audit: Audit) {
  function source(principal: Identity) {
    if (principal.scope !== 'browser') throw httpError(403, '请通过团队页面添加设备');
    const row = db.prepare(`SELECT a.id, a.tenant_id AS tenantId ${membership}
      WHERE m.tenant_id = ? AND m.member_id = ? AND ${enabled}`).get(principal.tenant.id, principal.user.id);
    if (!row) throw httpError(403, '仅有执行权限的团队成员可以添加自己的设备');
    return { tenantId: String(row.tenantId), accountId: String(row.id) };
  }
  function destinations(origin: string, accountId: string, deviceId?: string) {
    return db.prepare(`SELECT s.tenant_id AS tenantId, u.id AS memberId, s.device_id AS deviceId
      ${membership} ${grant} WHERE a.tenant_id = ? AND a.id = ? AND s.active AND ${enabled}
      ${deviceId === undefined ? '' : 'AND s.device_id = ?'} ORDER BY s.tenant_id, s.device_id`)
      .all(origin, accountId, ...(deviceId === undefined ? [] : [deviceId])) as unknown as SharedDeviceRoute[];
  }
  const project = (device: Device, owner: string): Device => ({
    id: device.id, owner, name: device.name, transport: 'connector', lastSeen: device.lastSeen,
    agents: device.agents, codexProjects: device.codexProjects, capabilities: device.capabilities, sharedFromPersonal: true
  });
  const reserved = (team: string, deviceId: string) => Boolean(db.prepare(
    'SELECT 1 FROM workspace_device_shares WHERE tenant_id = ? AND device_id = ?').get(team, deviceId));
  return {
    destinations, reserved,
    revokeForUser(userId: string) {
      const rows = db.prepare(`UPDATE workspace_device_shares s SET active = FALSE FROM workspace_memberships m
        WHERE s.tenant_id = m.tenant_id AND s.account_id = m.account_id AND s.active AND (m.member_id = ? OR m.account_id = ?)
        RETURNING s.tenant_id, s.device_id`).all(userId, userId);
      const teams = new Map<string, string[]>();
      for (const row of rows) {
        const id = String(row.tenant_id), devices = teams.get(id) || [];
        devices.push(String(row.device_id)); teams.set(id, devices);
      }
      return teams;
    },
    otherSpaces(tenantId: string, device: Device) {
      if (!device.owner) return [];
      let accountId = device.owner, origin = tenantId;
      if (device.sharedFromPersonal) {
        const row = db.prepare(`SELECT a.tenant_id AS origin, a.id FROM workspace_device_shares s
          JOIN organization_users a ON a.id = s.account_id WHERE s.tenant_id = ? AND s.device_id = ?`).get(tenantId, device.id);
        if (!row) throw httpError(409, '设备共享已变更，请刷新');
        origin = String(row.origin); accountId = String(row.id);
      }
      const teams = db.prepare('SELECT tenant_id FROM workspace_device_shares WHERE account_id = ? AND device_id = ?').all(accountId, device.id);
      return [origin, ...teams.map(row => String(row.tenant_id))].filter(id => id !== tenantId);
    },
    receiptDestinations(origin: string, accountId: string) {
      return db.prepare(`SELECT s.tenant_id AS tenantId, u.id AS memberId, s.device_id AS deviceId
        ${membership} ${grant} WHERE a.tenant_id = ? AND a.id = ?`).all(origin, accountId) as unknown as SharedDeviceRoute[];
    },
    devices(tenantId: string): Device[] {
      return db.prepare(`SELECT s.device_metadata ${membership} ${grant}
        WHERE s.tenant_id = ? AND s.active AND ${enabled} ORDER BY s.device_id`).all(tenantId)
        .map(row => JSON.parse(String(row.device_metadata)) as Device);
    },
    updateMetadata(route: SharedDeviceRoute, device: Device) {
      db.prepare('UPDATE workspace_device_shares SET device_metadata = ? WHERE tenant_id = ? AND device_id = ?')
        .run(JSON.stringify(project(device, route.memberId)), route.tenantId, device.id);
    },
    list(principal: Identity) {
      const { accountId, tenantId } = source(principal);
      const added = new Set(destinations(tenantId, accountId).filter(r => r.tenantId === principal.tenant.id).map(r => r.deviceId));
      const connected = new Set(readDevices(principal.tenant.id).filter(d => d.owner === principal.user.id).map(d => d.id));
      return { devices: readDevices(tenantId).filter(d => d.transport === 'connector' && d.owner === accountId && d.id !== 'local' && (!d.cardHidden || added.has(d.id)))
        .map(d => ({ id: d.id, name: d.name, online: Date.now() - Date.parse(d.lastSeen) < 90_000, added: added.has(d.id), connected: connected.has(d.id) })) };
    },
    setShared(principal: Identity, input: Record<string, unknown>, active: boolean) {
      const id = input.deviceId;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || id === 'local' || Object.keys(input).length !== 1) throw httpError(400, '请选择有效的个人设备');
      return mutate(principal.tenant.id, data => {
        const { accountId, tenantId } = source(principal);
        const binding = db.prepare('SELECT account_id AS accountId, active FROM workspace_device_shares WHERE tenant_id = ? AND device_id = ?')
          .get(principal.tenant.id, id);
        if (!active) {
          if (!binding || binding.accountId !== accountId) throw httpError(404, '团队共享设备不存在');
          if (!binding.active) return { deviceId: id };
          if (deviceHasPendingWork(data, id)) throw httpError(409, '设备还有待处理的团队工作，请先完成或取消后再停止共享');
          for (const request of data.directoryRequests || []) if (request.deviceId === id && request.status === 'pending') {
            request.status = 'cancelled'; request.message = '设备已停止共享'; request.updatedAt = new Date().toISOString();
          }
          for (const request of data.gitRequests || []) if (request.deviceId === id && request.status === 'pending') {
            request.status = 'failed'; request.message = '设备已停止共享'; request.updatedAt = new Date().toISOString();
          }
          db.prepare('UPDATE workspace_device_shares SET active = FALSE WHERE tenant_id = ? AND device_id = ?').run(principal.tenant.id, id);
          audit(principal.tenant.id, principal.user, 'workspace.device_removed', id);
          data.devices = data.devices.filter(d => d.id !== id);
          data.hiddenDeviceIds = data.hiddenDeviceIds?.filter(hidden => hidden !== id);
          return { deviceId: id };
        }
        const device = readDevices(tenantId).find(d => d.id === id && d.transport === 'connector' && d.owner === accountId && !d.cardHidden);
        if (!device) throw httpError(404, '个人设备不存在');
        const existing = data.devices.find(d => d.id === id);
        if (existing?.sharedFromPersonal && existing.owner === principal.user.id) return { deviceId: id };
        if (existing || (binding && binding.accountId !== accountId)) throw httpError(409, '团队中已有相同标识的设备');
        const shared = project(device, principal.user.id);
        db.prepare(`INSERT INTO workspace_device_shares (tenant_id, account_id, device_id, device_metadata) VALUES (?, ?, ?, ?)
          ON CONFLICT (tenant_id, device_id) DO UPDATE SET active = TRUE, device_metadata = excluded.device_metadata`)
          .run(principal.tenant.id, accountId, id, JSON.stringify(shared));
        audit(principal.tenant.id, principal.user, 'workspace.device_added', id);
        data.devices.push(shared);
        return { deviceId: id };
      });
    }
  };
}
