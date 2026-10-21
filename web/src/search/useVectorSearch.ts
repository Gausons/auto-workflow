import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api/client.js';
import type { SearchResult } from '../../../shared/searchTypes.js';

export function useVectorSearch(scope: 'tasks' | 'bugs', text: string, enabled: boolean, version: number) {
  const q = text.trim().toLowerCase();
  const [settled, setSettled] = useState('');
  useEffect(() => { const timer = setTimeout(() => setSettled(q), 350); return () => clearTimeout(timer); }, [q]);
  const query = useQuery({
    queryKey: ['search', scope, q, version],
    queryFn: ({ signal }) => apiRequest<SearchResult>(`/api/search?${new URLSearchParams({ scope, q })}`, { signal }),
    enabled: enabled && Boolean(q) && q === settled,
    retry: false, staleTime: 30_000
  });
  const current = enabled && q && q === settled && !query.isError ? query.data : undefined;
  return {
    ids: current?.ids || [],
    message: !enabled || !q ? '' : q !== settled || query.isFetching ? '正在搜索语义相关内容…'
      : query.isError ? '向量搜索请求失败，当前仅显示关键词匹配结果。' : current?.warning || (current?.mode === 'hybrid' ? '已包含语义相关结果' : ''),
    warning: Boolean(enabled && q && q === settled && (query.isError || current?.warning))
  };
}
