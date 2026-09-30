import path from 'node:path';
import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import type { AgentProject, GitRequest, TaskCenterData } from '../shared/taskTypes.js';
import { gitBranches, switchGitBranch } from './taskWorkspace.js';

type Request = (method: string, body?: unknown, endpoint?: string) => unknown;
export async function syncRemoteGit(options: { request: Request; deviceId: string; directory: string; projects: () => Promise<AgentProject[]> }, snapshot: TaskCenterData) {
  const root = path.join(options.directory, 'git');
  for (const candidate of (snapshot.gitRequests || []).filter(r => r.deviceId === options.deviceId && ['pending', 'running'].includes(r.status))) {
    if (!/^[a-f0-9-]{36}$/.test(candidate.id)) throw new Error('分支请求标识无效');
    const file = path.join(root, `${candidate.id}.json`);
    let receipt: GitRequest | undefined;
    try { receipt = JSON.parse(await readFile(file, 'utf8')) as GitRequest; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (receipt && (receipt.id !== candidate.id || receipt.deviceId !== candidate.deviceId || receipt.projectId !== candidate.projectId || receipt.cwd !== candidate.cwd || receipt.action !== candidate.action || receipt.branch !== candidate.branch)) throw new Error('分支操作日志与请求不匹配');
    if (candidate.status === 'pending' && !receipt) {
      if (Date.now() - Date.parse(candidate.createdAt) > 90_000) continue;
      const claimed = await options.request('POST', { requestId: candidate.id, action: 'claim' }, '/api/task-center/git-action') as GitRequest;
      if (claimed.id !== candidate.id || claimed.deviceId !== options.deviceId || claimed.status !== 'running') throw new Error('分支领取响应无效');
      receipt = { ...claimed, status: 'unknown', message: '连接器在分支操作期间中断，结果待核对；不会自动重试' };
      await mkdir(root, { recursive: true, mode: 0o700 });
      // Persist before invoking Git. A crash never replays a mutation.
      await writeFile(file, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
      try {
        const project = (await options.projects()).find(p => p.id === claimed.projectId);
        if (!project || (claimed.cwd !== project.cwd && !snapshot.directoryRequests?.some(r => r.status === 'completed' && r.deviceId === options.deviceId && r.projectId === project.id && r.requestedBy === claimed.requestedBy && r.cwd === claimed.cwd))) throw new Error('分支工作目录未经目标设备授权');
        const cwd = await realpath(claimed.cwd);
        // Discovery can be slow. Recheck and renew the claim immediately before bounded Git commands.
        await options.request('POST', { requestId: candidate.id, action: 'verify' }, '/api/task-center/git-action');
        const result = claimed.action === 'list' ? await gitBranches(cwd) : await switchGitBranch(cwd, claimed.branch, claimed.action === 'create');
        receipt = { ...claimed, status: 'completed', result };
      } catch (error) {
        const uncertain = error instanceof Error && 'uncertain' in error && error.uncertain === true;
        receipt = { ...claimed, status: uncertain ? 'unknown' : 'failed', message: error instanceof Error ? error.message : String(error) };
      }
      await writeFile(file + '.pending', JSON.stringify(receipt), { mode: 0o600 });
      await rename(file + '.pending', file);
    }
    // A second connector must not report unknown while the claiming process is still working.
    if (!receipt && Date.now() - Date.parse(candidate.updatedAt) > 120_000) receipt = { ...candidate, status: 'unknown', message: '分支操作回执缺失，结果待核对；不会自动重试' };
    if (receipt && (receipt.status !== 'unknown' || Date.now() - Date.parse(candidate.updatedAt) > 120_000)) await options.request('POST', { action: 'report', requestId: candidate.id, status: receipt.status, result: receipt.result, message: receipt.message }, '/api/task-center/git-action');
  }
}
