import type { WorkIssue } from './issueSources/types.js';

export interface IssueState { userKey: string; updatedAt: string; bugs: WorkIssue[] }

export function normalizeIssueState(raw: unknown, userKey: unknown): IssueState {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as { updatedAt?: unknown; bugs?: unknown } : {};
  return {
    userKey: String(userKey || 'default'),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    bugs: Array.isArray(value.bugs) ? value.bugs as WorkIssue[] : []
  };
}
