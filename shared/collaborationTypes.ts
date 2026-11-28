import type { Execution, ExecutionStatus, TaskStatus } from './taskTypes.js';

export interface CollaborationParticipant {
  id: string;
  name: string;
  responsibility: string;
  deviceId: string;
  deviceName?: string;
  projectId: string;
  projectName?: string;
  agent: string;
  cwd: string;
  taskId: string;
  taskStatus?: TaskStatus;
}

export interface CollaborationDocument {
  id: string;
  fromParticipantId: string;
  toParticipantId: string;
  title: string;
  body: string;
  sourceExecutionId?: string;
  createdAt: string;
  createdBy: string;
}

export interface CollaborationDocumentRecord extends CollaborationDocument {
  requestId: string;
}

export interface CollaborationRunRecord {
  id: string;
  requestId: string;
  participantId: string;
  executionId: string;
  documentIds: string[];
  instruction: string;
  createdAt: string;
  createdBy: string;
}

export interface CollaborationRun extends Omit<CollaborationRunRecord, 'requestId'> {
  status: ExecutionStatus;
  message: string;
  output: string;
  outputTruncated?: boolean;
  releaseStatus?: Execution['releaseStatus'];
}

export function isCollaborationRunUnresolved(run: Pick<Execution, 'status' | 'releaseStatus'>) {
  return ['queued', 'launching', 'running', 'waiting', 'unknown'].includes(run.status)
    || run.releaseStatus === 'releasing' || run.releaseStatus === 'failed';
}

export interface CollaborationSummary {
  id: string;
  title: string;
  goal: string;
  parentTaskId: string;
  taskStatus?: TaskStatus;
  revision: number;
  updatedAt: string;
  participantCount: number;
  documentCount: number;
}

export interface CollaborationDetail extends CollaborationSummary {
  createdAt: string;
  participants: CollaborationParticipant[];
  documents: CollaborationDocument[];
  runs: CollaborationRun[];
}

export interface CollaborationRecord {
  id: string;
  parentTaskId: string;
  title: string;
  goal: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  createRequestId: string;
  createFingerprint: string;
  participants: CollaborationParticipant[];
  documents: CollaborationDocumentRecord[];
  runs: CollaborationRunRecord[];
}
