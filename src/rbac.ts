export const ROLES = Object.freeze({
  owner: { label: '组织所有者', permissions: ['read', 'config.manage', 'people.manage', 'work.execute', 'work.approve', 'members.manage', 'audit.read'] },
  admin: { label: '管理员', permissions: ['read', 'config.manage', 'people.manage', 'work.execute', 'work.approve', 'members.manage', 'audit.read'] },
  operator: { label: '操作员', permissions: ['read', 'work.execute'] },
  viewer: { label: '只读成员', permissions: ['read'] }
});
export type Permission = typeof ROLES[keyof typeof ROLES]['permissions'][number];
interface Principal {
  user: { role: unknown };
  tenant: { id: string };
  expiresAt?: unknown;
  scope?: string;
}

export function permissionsFor(role: unknown): string[] {
  return typeof role === 'string' && Object.hasOwn(ROLES, role) ? [...ROLES[role as keyof typeof ROLES].permissions] : [];
}

export function permissionForRealtimeChannel(channel: unknown): string | null {
  if (channel === 'task-center') return 'read';
  if (channel === 'device-control') return 'work.execute';
  return null;
}

export function permissionForRoute(method: string | undefined, pathname: string): string | null {
  if (pathname === '/api/workspaces' && ['GET', 'POST'].includes(method || '')) return 'read';
  if (pathname === '/api/workspaces/switch' && method === 'POST') return 'read';
  if (pathname === '/api/workspaces/members' && method === 'GET') return 'read';
  if (pathname === '/api/workspaces/invitations' && method === 'POST') return 'members.manage';
  if (/^\/api\/workspaces\/invitations\/[a-zA-Z0-9-]+\/accept$/.test(pathname) && method === 'POST') return 'read';
  if (/^\/api\/workspaces\/invitations\/[a-zA-Z0-9-]+$/.test(pathname) && method === 'DELETE') return 'members.manage';
  if (pathname === '/api/auth/device-deployment' && method === 'POST') return 'work.execute';
  if (/^\/api\/sessions\/[a-f0-9]{64}\/continue-as-new$/.test(pathname) && method === 'POST') return 'work.execute';
  if ((pathname === '/api/conversations' || /^\/api\/conversations\/[a-f0-9]{64}\/(?:inherited|context-preview)$/.test(pathname)) && method === 'GET') return 'read';
  if (/^\/api\/conversations\/[a-f0-9]{64}\/transfer$/.test(pathname) && ['GET', 'POST'].includes(method || '')) return 'work.execute';
  if (/^\/api\/conversations\/[a-f0-9]{64}\/transfer\/objects\/[a-f0-9]{64}$/.test(pathname) && ['GET', 'POST'].includes(method || '')) return 'work.execute';
  if (/^\/api\/agent-sessions\/[a-f0-9]{64}\/continue$/.test(pathname) && ['GET', 'POST'].includes(method || '')) return method === 'POST' ? 'work.execute' : 'read';
  if (pathname === '/api/task-center/codex' && method === 'GET') return 'work.execute';
  if (['/api/task-center/device-state', '/api/task-center/device-updates'].includes(pathname) && method === 'GET') return 'work.execute';
  if (pathname === '/api/task-center/updates' && method === 'GET') return 'read';
  if (pathname === '/api/task-center/changes' && method === 'GET') return 'read';
  if (pathname === '/api/task-center/git' && ['GET', 'POST'].includes(method || '')) return 'work.execute';
  if (pathname === '/api/task-center/git-action' && method === 'POST') return 'work.execute';
  if (pathname === '/api/task-center/history-images' && method === 'POST') return 'work.execute';
  if (/^\/api\/agent-sessions\/[a-f0-9]{64}\/images(?:\/[a-f0-9]{64})?$/.test(pathname) && method === 'GET') return 'read';
  if (pathname === '/api/task-center/directory-picker' && ['GET', 'POST'].includes(method || '')) return 'work.execute';
  if (['/api/task-center/execute', '/api/task-center/execution-action', '/api/task-center/directory-action'].includes(pathname) && method === 'POST') return 'work.execute';
  if (pathname === '/api/task-center' && ['GET', 'POST'].includes(method || '')) return method === 'GET' ? 'read' : 'work.execute';
  if (method === 'GET' && (pathname === '/api/sessions' || /^\/api\/sessions\/[a-f0-9]{64}(?:\/(events|records))?$/.test(pathname))) return 'read';
  if (method === 'GET' && (pathname === '/api/agent-sessions' || /^\/api\/agent-sessions\/[a-f0-9]{64}$/.test(pathname))) return 'read';
  if (method === 'GET' && pathname === '/api/search') return 'read';
  if (method === 'GET' && ['/api/bootstrap', '/api/assignment/people'].includes(pathname)) return 'read';
  if (method === 'GET' && /^\/api\/bugs\/[^/]+\/attachments$/.test(pathname)) return 'read';
  if (method === 'GET' && pathname === '/api/issues/diagnostics') return 'config.manage';
  if (method === 'PUT' && pathname === '/api/config') return 'config.manage';
  if (method === 'PUT' && pathname === '/api/assignment/people') return 'people.manage';
  if (method === 'POST' && pathname === '/api/scheduler') return 'config.manage';
  if (method === 'POST' && ['/api/sync', '/api/assignments/apply-all'].includes(pathname)) return 'work.execute';
  if (method === 'POST' && /^\/api\/bugs\/[^/]+\/task$/.test(pathname)) return 'work.execute';
  if (method === 'POST' && /^\/api\/bugs\/[^/]+\/assignment\/(recommend|apply)$/.test(pathname)) return 'work.execute';
  return null; // New routes must be explicitly assigned a permission.
}

export function publicIdentity(principal: Principal) {
  const permissions = permissionsFor(principal.user.role).filter(permission => principal.scope !== 'connector' || ['read', 'work.execute'].includes(permission));
  return { user: principal.user, tenant: principal.tenant, permissions, expiresAt: principal.expiresAt };
}

export function connectorRouteAllowed(method: string | undefined, pathname: string) {
  if (pathname === '/api/task-center' && ['GET', 'POST'].includes(method || '')) return true;
  if (method === 'GET' && ['/api/task-center/device-state', '/api/task-center/device-updates'].includes(pathname)) return true;
  if (method === 'POST' && ['/api/task-center/execution-action', '/api/task-center/git-action', '/api/task-center/directory-action', '/api/task-center/history-images'].includes(pathname)) return true;
  if (method === 'GET' && /^\/api\/agent-sessions\/[a-f0-9]{64}\/images$/.test(pathname)) return true;
  if (method === 'GET' && /^\/api\/conversations\/[a-f0-9]{64}\/inherited$/.test(pathname)) return true;
  return ['GET', 'POST'].includes(method || '') && /^\/api\/conversations\/[a-f0-9]{64}\/transfer(?:\/objects\/[a-f0-9]{64})?$/.test(pathname);
}

export function connectorActionAllowed(pathname: string, action: unknown) {
  const actions: Record<string, string[]> = {
    '/api/task-center': ['heartbeat', 'ack'],
    '/api/task-center/execution-action': ['claim', 'report'],
    '/api/task-center/git-action': ['claim', 'verify', 'report'],
    '/api/task-center/directory-action': ['claim', 'report']
  };
  return typeof action === 'string' && actions[pathname]?.includes(action) === true;
}

export function httpError(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }
