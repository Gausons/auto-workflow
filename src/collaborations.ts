import { createHash, randomUUID } from 'node:crypto';
import type {
  CollaborationDetail, CollaborationDocumentRecord, CollaborationParticipant, CollaborationRecord, CollaborationSummary
} from '../shared/collaborationTypes.js';
import { isCollaborationRunUnresolved } from '../shared/collaborationTypes.js';
import type { Actor, AgentProject, Execution, Task, TaskCenterData } from '../shared/taskTypes.js';
import { collaborationProject, createCollaborationRun } from './collaborationExecution.js';
import {
  collaborationInput, collaborationRequestId, collaborationText, findCollaboration,
  requireCollaborationActor, requireCollaborationRevision, requireCollaborationTeam
} from './collaborationValidation.js';
import type { openDatabase } from './database.js';
import { httpError } from './rbac.js';
import { executionResult } from './sessionIdentity.js';

const maxDocumentLength = 16000;

function summary(record: CollaborationRecord, tasks: Map<string, Task>): CollaborationSummary {
  const { id, title, goal, parentTaskId, revision, updatedAt } = record;
  return { id, title, goal, parentTaskId, taskStatus: tasks.get(parentTaskId)?.status, revision, updatedAt, participantCount: record.participants.length, documentCount: record.documents.length };
}

function detail(record: CollaborationRecord, data: TaskCenterData): CollaborationDetail {
  const executions = new Map((data.executions || []).map(job => [job.id, job]));
  const tasks = new Map(data.tasks.map(task => [task.id, task]));
  return {
    ...summary(record, tasks), createdAt: record.createdAt,
    participants: record.participants.map(part => ({ ...part, taskStatus: tasks.get(part.taskId)?.status })),
    documents: record.documents.map(({ requestId: _requestId, ...document }) => document),
    runs: record.runs.map(({ requestId: _requestId, ...run }) => {
      const participant = record.participants.find(item => item.id === run.participantId);
      const job = executions.get(run.executionId);
      if (!job || !participant || job.taskId !== participant.taskId) {
        return { ...run, status: 'unknown', message: '执行记录缺失，请核对原分工执行', output: '' };
      }
      const result = executionResult(job);
      const output = result.status === 'completed' ? result.output || '' : '';
      const message = [result.message, result.collaborationSessionNotCreated && ['failed', 'interrupted'].includes(result.status)
        && '本轮未创建会话，处理后可重新启动分工。'].filter(Boolean).join(' ');
      return { ...run, status: result.status, message, releaseStatus: result.releaseStatus,
        output: output.slice(0, maxDocumentLength), outputTruncated: output.length > maxDocumentLength };
    })
  };
}

function newTask(collaborationId: string, title: string, content: string, at: string, event: string, parentTaskId?: string): Task {
  return {
    id: randomUUID(), collaborationId, title, content, parentTaskId, revision: 1, contextVersion: 1, status: 'ready', sessionIds: [],
    createdAt: at, updatedAt: at, events: [{ id: randomUUID(), at, message: event }]
  };
}

function priorCreation(data: TaskCenterData, key: string, fingerprint: string, actor: Actor) {
  const prior = data.collaborations?.find(item => item.createRequestId === key);
  if (!prior) return;
  if (prior.createdBy !== actor.id || prior.createFingerprint !== fingerprint) throw httpError(409, '请求标识已用于其他协作任务');
  return { id: prior.id };
}

function validSource(data: TaskCenterData, record: CollaborationRecord, sender: CollaborationParticipant, executionId: string) {
  const run = record.runs.find(item => item.executionId === executionId && item.participantId === sender.id);
  const source = run && data.executions?.find(job => job.id === run.executionId && job.taskId === sender.taskId);
  if (!source) throw httpError(400, '所选执行不属于当前任务的发送方');
  if (executionResult(source).status !== 'completed' || isCollaborationRunUnresolved(source)) throw httpError(409, '只能引用已成功完成的分工执行');
}

export function createCollaborations(options: {
  database: ReturnType<typeof openDatabase>;
  tenantId: string;
  execution: { targets(): Promise<{ projects: AgentProject[] }>; launch(job: Execution): void };
}) {
  const { database, tenantId, execution } = options;
  const team = () => requireCollaborationTeam(database, tenantId);
  const authorize = (actor: Actor) => requireCollaborationActor(database, tenantId, actor);
  const read = () => database.readTaskCenter(tenantId);
  return {
    list() {
      team();
      const data = read(), tasks = new Map(data.tasks.map(task => [task.id, task]));
      return { collaborations: (data.collaborations || []).map(record => summary(record, tasks)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
    },
    detail(id: string) {
      team();
      const data = read();
      return { collaboration: detail(findCollaboration(data, id), data) };
    },
    async create(raw: unknown, actor: Actor) {
      team();
      authorize(actor);
      const input = collaborationInput(raw);
      const key = collaborationRequestId(input.requestId);
      const title = collaborationText(input.title, 120), goal = collaborationText(input.goal, 8000);
      if (!Array.isArray(input.participants) || input.participants.length < 2 || input.participants.length > 6) throw httpError(400, '请设置 2–6 个 Agent 分工');
      const selections = input.participants.map(value => {
        const item = collaborationInput(value);
        return {
          name: collaborationText(item.name, 40), responsibility: collaborationText(item.responsibility, 2000),
          deviceId: collaborationText(item.deviceId, 80), projectId: collaborationText(item.projectId, 500)
        };
      });
      if (new Set(selections.map(item => item.name)).size !== selections.length) throw httpError(400, '各分工名称必须唯一');
      const fingerprint = createHash('sha256').update(JSON.stringify([title, goal, selections])).digest('hex');
      const prior = priorCreation(read(), key, fingerprint, actor);
      if (prior) return prior;
      const { projects } = await execution.targets();
      const targets = await Promise.all(selections.map(selection => collaborationProject(projects, selection)));
      return database.mutateTaskCenter(tenantId, data => {
        authorize(actor);
        const duplicate = priorCreation(data, key, fingerprint, actor);
        if (duplicate) return duplicate;
        const records = data.collaborations ||= [];
        if (records.length >= 100) throw httpError(409, '当前团队最多创建 100 个协作任务');
        const id = randomUUID(), at = new Date().toISOString();
        const parent = newTask(id, title, goal, at, '创建协作任务');
        data.tasks.push(parent);
        const participants = selections.map((selection, index) => {
          const project = targets[index];
          const task = newTask(id, `${title} · ${selection.name}`.slice(0, 120), selection.responsibility, at, '创建 Agent 分工', parent.id);
          data.tasks.push(task);
          return {
            ...selection, id: randomUUID(), cwd: project.cwd, agent: project.agent || 'codex', taskId: task.id,
            deviceName: project.deviceName, projectName: project.name
          };
        });
        records.push({
          id, parentTaskId: parent.id, title, goal, createdAt: at, updatedAt: at, createdBy: actor.id,
          createRequestId: key, createFingerprint: fingerprint, revision: 1, participants, documents: [], runs: []
        });
        return { id };
      });
    },
    publish(id: string, raw: unknown, actor: Actor) {
      team();
      const input = collaborationInput(raw);
      const requestId = collaborationRequestId(input.requestId);
      const fromParticipantId = collaborationText(input.fromParticipantId, 36);
      const toParticipantId = collaborationText(input.toParticipantId, 36);
      if (fromParticipantId === toParticipantId) throw httpError(400, '请选择不同的发送方和接收方');
      const title = collaborationText(input.title, 120);
      // Leading indentation and trailing spaces can be significant in Markdown.
      const body = input.body;
      if (typeof body !== 'string' || !body.trim() || body.length > maxDocumentLength) throw httpError(400, `交接正文需为 1–${maxDocumentLength} 个字符`);
      const sourceExecutionId = input.sourceExecutionId === undefined ? undefined : collaborationText(input.sourceExecutionId, 36);
      return database.mutateTaskCenter(tenantId, data => {
        authorize(actor);
        const record = findCollaboration(data, id);
        const prior = record.documents.find(item => item.requestId === requestId);
        if (prior) {
          if (prior.createdBy !== actor.id || prior.fromParticipantId !== fromParticipantId || prior.toParticipantId !== toParticipantId
            || prior.title !== title || prior.body !== body || prior.sourceExecutionId !== sourceExecutionId) throw httpError(409, '请求标识已用于其他交接文档');
          return { id: prior.id };
        }
        requireCollaborationRevision(record, input.revision);
        const sender = record.participants.find(item => item.id === fromParticipantId);
        const recipient = record.participants.find(item => item.id === toParticipantId);
        if (!sender || !recipient) throw httpError(400, '发送方和接收方必须属于当前协作任务');
        if (sourceExecutionId) validSource(data, record, sender, sourceExecutionId);
        if (record.documents.length >= 100) throw httpError(409, '每个任务最多发布 100 份交接文档');
        const parent = data.tasks.find(task => task.id === record.parentTaskId);
        if (!parent) throw httpError(409, '协作主任务记录缺失，请先核对任务');
        const at = new Date().toISOString();
        const document: CollaborationDocumentRecord = {
          id: randomUUID(), requestId, fromParticipantId, toParticipantId, title, body, sourceExecutionId, createdAt: at, createdBy: actor.id
        };
        record.documents.push(document);
        record.revision++;
        record.updatedAt = at;
        parent.events.unshift({ id: randomUUID(), at, message: `${sender.name} 向 ${recipient.name} 交接《${title}》` });
        parent.events = parent.events.slice(0, 200);
        parent.revision++;
        parent.updatedAt = at;
        return { id: document.id };
      });
    },
    run: createCollaborationRun(options)
  };
}
