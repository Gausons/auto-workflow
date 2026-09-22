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
}

export function permissionsFor(role: unknown): string[] {
  return typeof role === 'string' && Object.hasOwn(ROLES, role) ? [...ROLES[role as keyof typeof ROLES].permissions] : [];
}

export function permissionForRoute(method: string | undefined, pathname: string): string | null {
  if (/^\/api\/sessions\/[a-f0-9]{64}\/continue-as-new$/.test(pathname) && method === 'POST') return 'work.execute';
  if ((pathname === '/api/conversations' || /^\/api\/conversations\/[a-f0-9]{64}\/inherited$/.test(pathname)) && method === 'GET') return 'read';
  if (/^\/api\/agent-sessions\/[a-f0-9]{64}\/continue$/.test(pathname) && ['GET', 'POST'].includes(method || '')) return method === 'POST' ? 'work.execute' : 'read';
  if (pathname === '/api/task-center/codex' && method === 'GET') return 'work.execute';
  if (pathname === '/api/task-center/git' && method === 'POST') return 'work.execute';
  if (pathname === '/api/task-center/directory-picker' && ['GET', 'POST'].includes(method || '')) return 'work.execute';
  if (['/api/task-center/execute', '/api/task-center/execution-action', '/api/task-center/directory-action'].includes(pathname) && method === 'POST') return 'work.execute';
  if (pathname === '/api/task-center' && ['GET', 'POST'].includes(method || '')) return method === 'GET' ? 'read' : 'work.execute';
  if (method === 'GET' && (pathname === '/api/sessions' || /^\/api\/sessions\/[a-f0-9]{64}(?:\/(events|records))?$/.test(pathname))) return 'read';
  if (method === 'GET' && (pathname === '/api/agent-sessions' || /^\/api\/agent-sessions\/[a-f0-9]{64}$/.test(pathname))) return 'read';
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
  return { user: principal.user, tenant: principal.tenant, permissions: permissionsFor(principal.user.role), expiresAt: principal.expiresAt };
}

export function httpError(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }
