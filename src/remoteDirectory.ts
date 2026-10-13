import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { DirectoryRequest } from '../shared/taskTypes.js';

// The server may run on a different OS from the target device.
export function insideRemoteDirectory(root: string, cwd: string) {
  const paths = /^(?:[a-z]:[\\/]|\\\\)/i.test(root) ? path.win32 : path.posix;
  if (!paths.isAbsolute(root) || !paths.isAbsolute(cwd) || root.includes('\0') || cwd.includes('\0')) return false;
  const relative = paths.relative(root, cwd);
  return relative === '' || (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${paths.sep}`));
}

export function selectedRemoteDirectory(requests: DirectoryRequest[] | undefined, deviceId: string, requester: string | undefined, cwd: string) {
  if (!requester) return;
  return requests?.find(request => request.deviceId === deviceId && request.requestedBy === requester &&
    request.status === 'completed' && request.cwd && insideRemoteDirectory(request.cwd, cwd));
}

// Check both the requested path and its canonical location. A symlink beneath
// an allowed root must not grant access to a directory outside that root.
export async function resolveRemoteDirectory(cwd: string, roots: string[]) {
  const target = await realpath(cwd);
  for (const root of roots.filter(root => insideRemoteDirectory(root, cwd))) {
    try { if (insideRemoteDirectory(await realpath(root), target)) return target; }
    catch { /* A removed grant cannot authorize this directory. */ }
  }
  throw new Error('工作目录不在目标设备允许的目录范围内');
}
