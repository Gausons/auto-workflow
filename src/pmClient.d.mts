/** Typed boundary for the legacy JavaScript PM transport. */
import type { PmConfig, WorkIssue, IssueAttachment, Diagnostic } from './issueSources/types.ts';
interface PmOptions extends PmConfig {
  accessKey?: string;
  accessSecret?: string;
  accessToken?: string;
}
export function fetchDefectsFromPm(options: PmOptions & { lastSyncTime?: string | null }): Promise<WorkIssue[]>;
export function fetchBugAttachmentsFromPm(options: PmOptions & { aid: string }): Promise<IssueAttachment[]>;
export function moveDefectInPm(options: PmOptions & { aid: string; fieldData: { assignee: string } }): Promise<unknown>;
export function diagnosePm(options: PmOptions): Promise<Diagnostic[]>;
