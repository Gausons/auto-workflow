export type TaskStatus = 'waiting' | 'error' | 'running' | 'ready' | 'review' | 'completed';
export type ExecutionStatus = 'blocked' | 'queued' | 'launching' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed' | 'unknown';
export type HandoffMode = 'continue' | 'branch' | 'reference';
export type HandoffStatus = 'pending' | 'received' | 'started' | 'cancelled' | 'failed';

export interface TaskContext {
  goal: string;
  constraints: string;
  decisions: string;
  next: string;
  files: string;
}

export interface TaskEvent {
  id: string;
  at: string;
  message: string;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  revision: number;
  contextVersion: number;
  context?: TaskContext;
  content?: string;
  sessionIds: string[];
  events: TaskEvent[];
  createdAt: string;
  updatedAt: string;
  parentTaskId?: string;
  source?: { type: 'defect'; id: string; code: string };
}

export interface ReasoningEffort {
  id: string;
  name: string;
  description?: string;
}

export interface AgentModel {
  id: string;
  name: string;
  description?: string;
  defaultReasoningEffort?: string;
  reasoningEfforts?: ReasoningEffort[];
}

export interface AgentProject {
  id: string;
  name?: string;
  cwd: string;
  protocol?: 'acp' | 'legacy';
  agent?: string;
  appServerProjectId?: string | null;
  models?: AgentModel[];
  defaultModel?: string;
  defaultReasoningEffort?: string;
  reasoningEfforts?: ReasoningEffort[];
  deviceId?: string;
  deviceName?: string;
  online?: boolean;
  commonDirectories?: string[];
}

export interface Device {
  id: string;
  name: string;
  owner?: string;
  agents: string[];
  lastSeen: string;
  transport: 'manual' | 'connector';
  online?: boolean;
  codexProjects?: AgentProject[];
}

export interface Session {
  id: string;
  nativeId?: string | null;
  sessionId?: string | null;
  historyId?: string;
  source?: string;
  sourceSessionId?: string;
  taskId?: string;
  contextId?: string;
  createRequestId?: string;
  createFingerprint?: string;
  projectId?: string;
  appServerProjectId?: string | null;
  agent: string;
  agentLabel?: string;
  deviceId: string;
  protocol?: 'acp' | 'legacy';
  title: string;
  cwd: string;
  status?: string;
  excerpt?: string;
  partial?: boolean;
  missing?: boolean;
  managed?: boolean;
  archived?: boolean;
  preparationError?: string;
  pendingMessage?: string;
  pendingRequestId?: string | null;
  createdAt?: string;
  updatedAt: string;
  workspaces?: string[];
  model?: string;
  reasoningEffort?: string;
  branch?: string;
  messageCount?: number;
}

export interface InteractionOption { label: string; description?: string }
export interface InteractionQuestion { id: string; question: string; options?: InteractionOption[] }
export interface InteractionRequest {
  id?: string;
  method?: string;
  params?: { command?: string; questions?: InteractionQuestion[]; [key: string]: unknown };
}

export interface ExecutionControl {
  id: string;
  action: string;
  decision?: string;
  answers?: Record<string, FormDataEntryValue | null>;
}

export interface PromptImageReference {
  id: string;
  path: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  sha256: string;
  size: number;
}

export interface Execution {
  id: string;
  requestId?: string;
  historySessionId?: string;
  conversationId?: string;
  sourceSessionId?: string | null;
  contextId?: string;
  contextDigest?: string;
  contextCompacted?: boolean;
  taskId: string;
  contextVersion: number;
  deviceId: string;
  projectId?: string;
  appServerProjectId?: string | null;
  cwd: string;
  model?: string | null;
  reasoningEffort?: string | null;
  title: string;
  prompt: string;
  promptImages?: PromptImageReference[];
  contextImageDelivery?: 'native' | 'file-reference';
  userMessage?: string;
  status: ExecutionStatus;
  createdAt: string;
  updatedAt: string;
  message?: string;
  output?: string;
  threadId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  resumeThreadId?: string;
  resumeSessionId?: string;
  protocol?: 'acp' | 'legacy';
  agent?: string;
  agentLabel?: string;
  previousTaskStatus?: TaskStatus;
  request?: InteractionRequest | null;
  control?: ExecutionControl | null;
  controlError?: string | null;
  contextEvents?: unknown[];
  attachments?: Array<{ path: string; name?: string }>;
  desktopMessage?: string;
  desktopOpened?: boolean;
  executionTransport?: string;
  releaseStatus?: 'releasing' | 'released' | 'failed';
  managed?: boolean;
  replay?: boolean;
  errorCode?: string;
}

export interface HandoffPacket {
  title: string;
  contextVersion: number;
  content: string;
  context: TaskContext;
  instruction: string;
  sources: Array<Pick<Session, 'id' | 'title' | 'deviceId' | 'agent' | 'nativeId' | 'cwd' | 'excerpt' | 'updatedAt'>>;
  limitations: string;
}

export interface Handoff {
  id: string;
  taskId: string;
  destinationTaskId: string;
  mode: HandoffMode;
  deviceId: string;
  agent: string;
  targetSessionId?: string | null;
  sourceSessionId?: string | null;
  sessionId?: string;
  status: HandoffStatus;
  createdAt: string;
  updatedAt: string;
  sourceRevision: number;
  packet: HandoffPacket;
  note?: string;
}

export interface DirectoryRequest {
  id: string;
  deviceId: string;
  projectId: string | null;
  requestedBy: string;
  status: 'pending' | 'selecting' | 'completed' | 'cancelled' | 'failed';
  createdAt: string;
  updatedAt: string;
  cwd?: string | null;
  message?: string | null;
}

export interface TaskCenterData {
  tasks: Task[];
  devices: Device[];
  sessions: Session[];
  handoffs: Handoff[];
  executions: Execution[];
  directoryRequests?: DirectoryRequest[];
}

export interface HistoryMessage {
  role: string;
  text?: string;
  name?: string;
  callId?: string;
  turnId?: string;
  timestamp?: string;
  images?: Array<{ dataUrl?: string; alt?: string }>;
}

export interface Actor { id: string }
export type Api = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
