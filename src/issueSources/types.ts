/** Provider-neutral contract consumed by the workbench. No credentials or raw API payloads. */
export interface IssueAttachment {
  id?: string;
  aid?: string;
  name: string;
  url: string;
  thumbnailUrl?: string;
  contentType?: string;
  size?: number;
}

export interface WorkIssue {
  id: string;
  aid: string;
  code: string;
  title: string;
  status: string;
  priority: string;
  severity: string;
  assignee: string;
  assigneeId: string;
  product: string;
  category: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  source?: string;
  sourceId?: string;
  sourceUrl?: string;
  sourceStatus?: string;
  attachments?: IssueAttachment[];
  attachmentsLoaded?: boolean;
}

export interface Diagnostic {
  name: string;
  ok: boolean;
  status: number;
  message: string;
}

export interface IssueSource {
  readonly id: string;
  readonly label: string;
  readonly configured: boolean;
  readonly assignmentOperationCode: string;
  /** Empty preserves existing storage keys. Other sources isolate sites and query scopes. */
  readonly storageScope: string;
  checkpoint?(startedAt: Date): string;
  validate(): void;
  sync(options: { lastSyncTime?: string | null }): Promise<WorkIssue[]>;
  attachments(issue: Pick<WorkIssue, 'aid'>): Promise<IssueAttachment[]>;
  assign(issue: Pick<WorkIssue, 'aid'>, assigneeId: string): Promise<unknown>;
  diagnose(): Promise<Diagnostic[]>;
  /** Optional authenticated attachment download, enforcing a byte limit. */
  downloadAttachment?(url: string, maxBytes: number): Promise<Uint8Array>;
}

export type Environment = Record<string, string | undefined>;
export type SourceConfig = Record<string, unknown>;
export interface SourceContext {
  environment: Environment;
  config: SourceConfig;
  fetch?: typeof globalThis.fetch;
}
export type IssueSourceFactory = (context: SourceContext) => IssueSource;
