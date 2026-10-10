import { apiRequest, ApiError } from '../api/client.js';
import type { QueryClient } from '@tanstack/react-query';
import { waitForRemoteRequest } from './remoteRequest.js';
import type { AgentProject, GitBranchState, GitRequest } from '../../../shared/taskTypes.js';

export async function requestGitBranches(client: QueryClient, project: AgentProject, cwd: string, action: 'list' | 'switch' | 'create' = 'list', branch?: string, signal?: AbortSignal): Promise<GitBranchState> {
  const body = { action, branch, projectId: project.id, deviceId: project.deviceId, cwd };
  if (project.deviceId === 'local') return apiRequest<GitBranchState>('/api/task-center/git', { method: 'POST', body: JSON.stringify(body), signal });
  if (!project.gitBranches) throw new Error('请升级并重启目标设备连接器以启用分支管理');
  if (!project.online) throw new Error('目标设备离线，请连接后再读取分支');
  const key = `bugflow.git:${JSON.stringify(body)}`;
  const requestId = action === 'list' ? crypto.randomUUID() : sessionStorage.getItem(key) || crypto.randomUUID();
  if (action !== 'list') sessionStorage.setItem(key, requestId);
  let result: GitRequest;
  try {
    result = await apiRequest<GitRequest>('/api/task-center/git', { method: 'POST', body: JSON.stringify({ ...body, requestId }), signal });
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) sessionStorage.removeItem(key);
    throw error;
  }
  result = await waitForRemoteRequest(client, 'gitRequests', requestId, result,
    () => apiRequest<GitRequest>(`/api/task-center/git?requestId=${encodeURIComponent(requestId)}`, { signal }), 135_000, signal);
  sessionStorage.removeItem(key);
  if (result.status !== 'completed' || !result.result) throw new Error(result.message || '远端分支操作失败');
  return result.result;
}
