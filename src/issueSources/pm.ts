import { diagnosePm, fetchBugAttachmentsFromPm, fetchDefectsFromPm, moveDefectInPm } from '../pmClient.mjs';
import type { IssueSourceFactory, WorkIssue, IssueAttachment } from './types.ts';

/** Compatibility boundary: the existing PM transport and field mapping remain intact. */
export const createPmSource: IssueSourceFactory = ({ config, environment }) => {
  const auth = { accessKey: environment.PM_ACCESS_KEY, accessSecret: environment.PM_ACCESS_SECRET, accessToken: environment.PM_ACCESS_TOKEN };
  const options = { ...config, ...auth };
  const configured = Boolean((auth.accessKey && auth.accessSecret) || auth.accessToken);
  function validate() {
    if (!configured) throw new Error('请配置 PM_ACCESS_KEY / PM_ACCESS_SECRET 或 PM_ACCESS_TOKEN。');
    if (!config.lineId && !config.filterId) throw new Error('PM 需要配置 lineId 或 filterId。');
  }
  return {
    id: 'pm', label: '内部 PM', configured, storageScope: '', validate, assignmentOperationCode: 'base/move',
    async sync({ lastSyncTime }) {
      validate();
      return await fetchDefectsFromPm({ ...options, lastSyncTime }) as WorkIssue[];
    },
    async attachments(issue) {
      return await fetchBugAttachmentsFromPm({ ...options, aid: issue.aid }) as IssueAttachment[];
    },
    async assign(issue, assigneeId) {
      validate();
      return moveDefectInPm({ ...options, aid: issue.aid, fieldData: { assignee: assigneeId } });
    },
    async diagnose() {
      validate();
      return diagnosePm(options);
    }
  };
};
