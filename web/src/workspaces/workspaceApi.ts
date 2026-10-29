import { useQuery } from '@tanstack/react-query';
import { apiRequest, saveSessionToken } from '../api/client.js';

export type WorkspaceRole = 'owner' | 'admin' | 'operator' | 'viewer';
export interface Workspace { id: string; name: string; role: WorkspaceRole; kind: 'personal' | 'team' }
export interface Invitation { id: string; name?: string; username?: string; role: WorkspaceRole; expiresAt: number }
export interface WorkspaceData { currentId: string; workspaces: Workspace[]; invitations: Invitation[] }
export interface WorkspaceMember { id: string; username: string; displayName: string; role: WorkspaceRole; enabled: number; updatedAt: string }
export const roleLabels: Record<WorkspaceRole, string> = { owner: '所有者', admin: '管理员', operator: '成员', viewer: '只读成员' };
export function useWorkspaces() {
  return useQuery({ queryKey: ['workspaces'], queryFn: ({ signal }) => apiRequest<WorkspaceData>('/api/workspaces', { signal }), refetchInterval: 30_000 });
}
export async function enterWorkspace(tenantId: string) {
  const session = await apiRequest<{ token: string }>('/api/workspaces/switch', { method: 'POST', body: JSON.stringify({ tenantId }) });
  saveSessionToken(session.token);
  // A full navigation disposes live streams and every in-memory cache from the previous tenant.
  window.location.assign('/space');
}
