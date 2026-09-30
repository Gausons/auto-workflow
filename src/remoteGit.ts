import type { GitBranchState, GitRequest, TaskCenterData } from '../shared/taskTypes.js';
import { httpError } from './rbac.js';

interface Database {
  readTaskCenter(tenantId: string): TaskCenterData;
  mutateTaskCenter<T>(tenantId: string, update: (data: TaskCenterData) => T): T;
}
type Actor = { id?: string };
export interface RemoteGitInput { requestId?: string; deviceId?: string; projectId?: string; cwd?: string; action?: string; branch?: unknown }
const live = (request: GitRequest) => ['pending', 'running'].includes(request.status);
export function assertNoRemoteGitMutation(data: TaskCenterData, deviceId: string) {
  for (const r of data.gitRequests || []) expire(r);
  if (data.gitRequests?.some(r => r.deviceId === deviceId && r.action !== 'list' && live(r))) throw httpError(409, '目标设备正在处理分支操作，请稍后执行任务');
}
function expire(request: GitRequest) {
  const age = Date.now() - Date.parse(request.updatedAt);
  if (request.status === 'pending' && age > 90_000) { request.status = 'failed'; request.message = '设备未及时领取分支操作，请检查连接器后重试'; }
  if (request.status === 'running' && age > 120_000) { request.status = 'unknown'; request.message = '分支操作结果待核对，请刷新分支并在目标设备确认；不会自动重试'; }
}
function branchResult(value: unknown): GitBranchState {
  if (!value || typeof value !== 'object') throw httpError(400, '分支回报无效');
  const r = value as Partial<GitBranchState>;
  if (typeof r.repository !== 'boolean' || typeof r.current !== 'string' || r.current.length > 200 || !Number.isSafeInteger(r.changes) || r.changes! < 0 || !Array.isArray(r.branches) || r.branches.length > 10000 || r.branches.some(b => typeof b !== 'string' || b.length > 200)) throw httpError(400, '分支回报无效');
  return { repository: r.repository, current: r.current, changes: r.changes!, branches: r.branches };
}
export function createRemoteGit(database: Database, tenantId: string) {
  return {
    submit(input: RemoteGitInput, actor: Actor): GitRequest {
      if (!actor.id) throw httpError(403, '需要登录账号');
      if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId) || !['list', 'switch', 'create'].includes(input.action || '') || typeof input.projectId !== 'string' || typeof input.deviceId !== 'string') throw httpError(400, '分支请求参数无效');
      if (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd.length > 2000)) throw httpError(400, '工作目录无效');
      if (input.action !== 'list' && (typeof input.branch !== 'string' || !input.branch || input.branch.length > 200 || input.branch.startsWith('-') || /[\x00-\x20]/.test(input.branch))) throw httpError(400, '分支名称无效');
      return database.mutateTaskCenter(tenantId, data => {
        const existing = data.gitRequests?.find(r => r.id === input.requestId);
        if (existing) {
          if (existing.requestedBy !== actor.id) throw httpError(403, '无权访问该分支请求');
          if (existing.deviceId !== input.deviceId || existing.projectId !== input.projectId || existing.action !== input.action || (input.cwd?.trim() && existing.cwd !== input.cwd.trim()) || existing.branch !== (input.action === 'list' ? undefined : input.branch)) throw httpError(409, '请求标识已用于其他分支操作');
          expire(existing); return structuredClone(existing);
        }
        const device = data.devices.find(d => d.id === input.deviceId);
        const project = device?.codexProjects?.find(p => p.id === input.projectId);
        if (!device || !project) throw httpError(404, '远端执行目标不存在');
        if (!device.capabilities?.gitBranches) throw httpError(422, '请升级并重启目标设备连接器以启用分支管理');
        if (Date.now() - Date.parse(device.lastSeen) > 90_000) throw httpError(409, '目标设备离线，请连接后再操作分支');
        const cwd = input.cwd?.trim() || project.cwd;
        if (cwd !== project.cwd && !data.directoryRequests?.some(r => r.deviceId === device.id && r.projectId === project.id && r.requestedBy === actor.id && r.status === 'completed' && r.cwd === cwd)) throw httpError(403, '请先在目标设备使用“选择目录”授权此工作目录');
        for (const r of data.gitRequests || []) expire(r);
        if (input.action !== 'list') {
          assertNoRemoteGitMutation(data, device.id);
          if (data.executions?.some(j => j.deviceId === device.id && (['queued', 'launching', 'running', 'waiting', 'unknown'].includes(j.status) || j.releaseStatus === 'releasing'))) throw httpError(409, '目标设备有任务正在执行或结果待核对，请结束后再切换分支');
        }
        const now = new Date().toISOString();
        const request: GitRequest = { id: input.requestId!, requestedBy: actor.id!, deviceId: device.id, projectId: project.id, cwd, action: input.action as GitRequest['action'], branch: input.action === 'list' ? undefined : input.branch as string, status: 'pending', createdAt: now, updatedAt: now };
        // Read requests may be frequent; retain mutation receipts for idempotency.
        data.gitRequests = (data.gitRequests || []).filter(r => r.action !== 'list' || live(r) || Date.now() - Date.parse(r.updatedAt) < 300_000);
        data.gitRequests.push(request);
        return structuredClone(request);
      });
    },
    status(id: string, actor: Actor): GitRequest {
      const current = database.readTaskCenter(tenantId).gitRequests?.find(r => r.id === id);
      if (!current) throw httpError(404, '分支请求不存在');
      if (!actor.id || current.requestedBy !== actor.id) throw httpError(403, '无权查看该分支请求');
      const result = structuredClone(current); expire(result);
      if (result.status !== current.status) return database.mutateTaskCenter(tenantId, data => { const r = data.gitRequests!.find(r => r.id === id)!; expire(r); return structuredClone(r); });
      return result;
    },
    action(input: { requestId?: string; action?: string; status?: string; result?: unknown; message?: string }, actor: Actor) {
      return database.mutateTaskCenter(tenantId, data => {
        const r = data.gitRequests?.find(r => r.id === input.requestId);
        if (!r) throw httpError(404, '分支请求不存在');
        if (!actor.id || data.devices.find(d => d.id === r.deviceId)?.owner !== actor.id) throw httpError(403, '只有目标设备连接器账号可以处理分支请求');
        expire(r);
        if (input.action === 'claim') {
          if (r.status !== 'pending') throw httpError(409, '分支请求已被领取或过期');
          if (r.action !== 'list' && data.executions?.some(j => j.deviceId === r.deviceId && (['launching', 'running', 'waiting', 'unknown'].includes(j.status) || j.releaseStatus === 'releasing'))) throw httpError(409, '目标设备有任务正在执行');
          r.status = 'running'; r.updatedAt = new Date().toISOString(); return structuredClone(r);
        }
        if (input.action === 'verify') {
          if (r.status !== 'running') throw httpError(409, '分支请求已过期，未执行操作');
          r.updatedAt = new Date().toISOString(); return structuredClone(r);
        }
        if (input.action !== 'report' || !['completed', 'failed', 'unknown'].includes(input.status || '')) throw httpError(400, '分支回报无效');
        if (r.status !== 'running') return structuredClone(r);
        if (input.status === 'completed') r.result = branchResult(input.result);
        r.status = input.status as GitRequest['status']; r.message = String(input.message || '').slice(0, 2000); r.updatedAt = new Date().toISOString();
        return structuredClone(r);
      });
    }
  };
}
