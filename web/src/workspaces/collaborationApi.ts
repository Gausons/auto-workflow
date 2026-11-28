import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client.js';

export const collaborationsPath = '/api/workspaces/collaborations';
export const collaborationKey = (workspaceId: string) => ['collaborations', workspaceId];
export const collaborationPath = (id: string) => `${collaborationsPath}/${encodeURIComponent(id)}`;

export function useCollaborationWrite(workspaceId: string, path: string) {
  const client = useQueryClient();
  const request = useRef<{ content: string; id: string } | null>(null);
  return useMutation({
    mutationFn: async ({ data, revision }: { data: object; revision?: number }) => {
      const content = JSON.stringify(data);
      if (request.current?.content !== content) request.current = { content, id: crypto.randomUUID() };
      return apiRequest<{ id: string }>(path, { method: 'POST', body: JSON.stringify({ ...data, requestId: request.current.id, revision }) });
    },
    retry: false,
    onSuccess: () => { request.current = null; },
    onSettled: () => client.invalidateQueries({ queryKey: collaborationKey(workspaceId) }),
  });
}
