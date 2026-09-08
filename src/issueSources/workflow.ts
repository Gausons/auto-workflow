import type { WorkIssue } from './types.ts';

/** Preserve the historical plan field without showing internal PM endpoints for other providers. */
export function sourceTransitionPlan<T>(issue: Pick<WorkIssue, 'source' | 'sourceUrl'>, legacyPlan: () => T) {
  if (!issue.source || issue.source === 'pm') return legacyPlan();
  return {
    source: issue.source,
    automaticTransition: false,
    issueUrl: issue.sourceUrl || '',
    instructions: '修复审核后，请在原任务平台人工执行状态流转；当前适配器支持查询、附件和经办人分配。'
  };
}
