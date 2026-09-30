import { apiRequest, ApiError } from '../api/client.js';
import type { AgentProject, GitBranchState, GitRequest } from '../../../shared/taskTypes.js';

export async function requestGitBranches(project: AgentProject, cwd: string, action: 'list' | 'switch' | 'create' = 'list', branch?: string, signal?: AbortSignal): Promise<GitBranchState> {
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
  const deadline = Date.now() + 135_000;
  while (result.status === 'pending' || result.status === 'running') {
    if (Date.now() > deadline) throw new Error('等待远端分支结果超时，请检查连接器；重试将查询同一请求');
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException('已取消读取分支', 'AbortError')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 1000);
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
    result = await apiRequest<GitRequest>(`/api/task-center/git?requestId=${encodeURIComponent(requestId)}`, { signal });
  }
  sessionStorage.removeItem(key);
  if (result.status !== 'completed' || !result.result) throw new Error(result.message || '远端分支操作失败');
  return result.result;
}
