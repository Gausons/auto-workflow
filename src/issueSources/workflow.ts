import type { WorkIssue } from './types.ts';

/** Platform-specific transitions stay outside the public workflow engine. */
export function sourceTransitionPlan(issue: Pick<WorkIssue, 'source' | 'sourceUrl'>) {
  return {
    source: issue.source || '',
    automaticTransition: false,
    issueUrl: issue.sourceUrl || '',
    instructions: '修复审核后，请在原任务平台人工执行状态流转；当前适配器支持查询、附件和经办人分配。'
  };
}
