export interface GroupChatParticipant {
  id: string;
  name: string;
  responsibility: string;
  agent: string;
  deviceId: string;
  projectId: string;
  cwd: string;
  directoryRequestId?: string;
}
export interface GroupChatMessage {
  id: string;
  roundId: string;
  role: 'user' | 'agent';
  authorId: string;
  authorName: string;
  text: string;
  createdAt: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'unknown' | 'stopped';
  executionId?: string;
  taskId?: string;
  detail?: string;
}
export interface GroupChatRoom {
  id: string;
  name: string;
  revision: number;
  createRequestId: string;
  createFingerprint: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  participants: GroupChatParticipant[];
  messages: GroupChatMessage[];
  round?: { id: string; actorId: string; status: 'running' | 'completed' | 'blocked' | 'stopped' };
}
