// @ts-nocheck
export const ROLES = Object.freeze({
  owner: { label: '组织所有者', permissions: ['read', 'config.manage', 'people.manage', 'work.execute', 'work.approve', 'members.manage', 'audit.read'] },
  admin: { label: '管理员', permissions: ['read', 'config.manage', 'people.manage', 'work.execute', 'work.approve', 'members.manage', 'audit.read'] },
  operator: { label: '操作员', permissions: ['read', 'work.execute'] },
  viewer: { label: '只读成员', permissions: ['read'] }
});

export function permissionsFor(role) {
  return Object.hasOwn(ROLES, role) ? [...ROLES[role].permissions] : [];
}

export function permissionForRoute(method, pathname) {
  if (pathname === '/api/task-center/codex' && method === 'GET') return 'work.execute';
  if (['/api/task-center/execute', '/api/task-center/execution-action'].includes(pathname) && method === 'POST') return 'work.execute';
  if (pathname === '/api/task-center' && ['GET', 'POST'].includes(method)) return method === 'GET' ? 'read' : 'work.execute';
  if (method === 'GET' && (pathname === '/api/sessions' || /^\/api\/sessions\/[a-f0-9]{64}(?:\/(events|records))?$/.test(pathname))) return 'read';
  if (method === 'GET' && (pathname === '/api/agent-sessions' || /^\/api\/agent-sessions\/[a-f0-9]{64}$/.test(pathname))) return 'read';
  if (method === 'GET' && ['/api/bootstrap', '/api/workflows/records', '/api/assignment/people'].includes(pathname)) return 'read';
  if (method === 'GET' && /^\/api\/bugs\/[^/]+\/attachments$/.test(pathname)) return 'read';
  if (method === 'GET' && pathname === '/api/issues/diagnostics') return 'config.manage';
  if (method === 'PUT' && pathname === '/api/config') return 'config.manage';
  if (method === 'PUT' && pathname === '/api/assignment/people') return 'people.manage';
  if (method === 'POST' && pathname === '/api/scheduler') return 'config.manage';
  if (method === 'POST' && ['/api/sync', '/api/assignments/apply-all', '/api/workflows/run'].includes(pathname)) return 'work.execute';
  if (method === 'POST' && /^\/api\/bugs\/[^/]+\/assignment\/(recommend|apply)$/.test(pathname)) return 'work.execute';
  if (method === 'POST' && /^\/api\/workflows\/[^/]+\/(supplement|start|stop|verify\/start)$/.test(pathname)) return 'work.execute';
  if (method === 'POST' && /^\/api\/workflows\/[^/]+\/(review\/start|nodes\/[^/]+\/complete|operation-log\/upload)$/.test(pathname)) return 'work.approve';
  return null; // New routes must be explicitly assigned a permission.
}

export function publicIdentity(principal) {
  return { user: principal.user, tenant: principal.tenant, permissions: permissionsFor(principal.user.role), expiresAt: principal.expiresAt };
}

export function httpError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
