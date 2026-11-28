import { createVectorSearch, searchQuery, vectorSearchEnabled } from './vectorSearch.js';
import { bugSearchDocuments, taskSearchDocuments } from './searchDocuments.js';
import { readJson, readBytes } from './http/body.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createTaskCenterStream, taskCenterSince } from './taskCenterStream.js';
import { sharedWorkRoute, type DeviceWorkKind } from './sharedDeviceWork.js';
import { createDeviceControl } from './deviceControl.js';
import path from 'node:path';
import { taskContent } from '../shared/taskContent.js';
import { assignmentModelError, assignmentResponseText, requestAssignmentModel } from './assignmentModelConnection.js';
import { assignmentConnectionFor, assignmentConnectionKey, assignmentModelDeployment, assignmentModelProbe, loadAssignmentModelSettings, publicAssignmentModelSettings, storedAssignmentModelSettings, updateAssignmentModelSettings } from './assignmentModelSettings.js';
import { createHash } from 'node:crypto';
import { collaborationRoute, connectorActionAllowed, httpError, publicIdentity } from './rbac.js';
import type { ExecutionFeedback, RealtimeEvent, RealtimeSubscription } from '../shared/realtime.js';
import { createSessionDelivery } from './sessionDelivery/index.ts';
import { createAgentHistory } from './agentHistory/index.js';
import { createTaskCenter } from './taskCenter.js';
import { createCodexExecution } from './codexExecution.js';
import { createRemoteGit } from './remoteGit.js';
import { createHistoryImages } from './historyImages.js';
import { createGroupChats } from './groupChats.js';
import { createCollaborations } from './collaborations.js';
import { createConversations } from './conversations.js';
import { createContextModelSummarizer } from './contextModelSummary.js';
import { applyAssignmentBusinessRules, buildAssignmentJsonSchema, buildAssignmentSystemPrompt, buildAssignmentUserPayload, isAssignmentCandidate, normalizeAssignmentPeople, normalizeAssignmentRecommendation } from './assignmentEngine.js';
import { createIssueSource, issueSourceConfig, issueSourceId, sourceStorageKey, syncCheckpoint } from './issueSources/index.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Tenant } from './database.js';
import type { Environment, IssueAttachment, WorkIssue } from './issueSources/types.js';

type Database = ReturnType<typeof import('./database.js').openDatabase>;
type JsonObject = Record<string, unknown>;
interface Principal { user: { id: string; role: string }; tenant: Tenant; expiresAt?: unknown; scope?: string; connectorDeviceId?: string }
interface DeviceServices {
  execution: Pick<ReturnType<typeof createCodexExecution>, 'action' | 'directoryAction'>;
  git: Pick<ReturnType<typeof createRemoteGit>, 'action'>;
  conversations: Pick<ReturnType<typeof createConversations>, 'transfer' | 'transferObject' | 'inherited'>;
  taskCenter: Pick<ReturnType<typeof createTaskCenter>, 'command'>;
}
interface AssignmentPerson { name: string; employeeId: string; responsibility: string }
interface AssignmentRecommendation {
  status: string; source?: string; reason?: string; error?: string; model?: string; assigneeId?: string;
  assigneeName?: string; confidence?: string; matchedResponsibility?: string; assigned?: boolean;
  assignedAt?: string | null; failedAt?: string; createdAt?: string; assignmentOperation?: unknown; assignmentResult?: unknown;
}
interface RuntimeIssue extends WorkIssue {
  expected?: string; actual?: string; reproduceSteps?: unknown[]; attachmentsError?: string;
  assignmentRecommendation?: AssignmentRecommendation;
}
interface RuntimeConfig extends JsonObject {
  mode: string; assignee: string; operatorId: string; selfOnly: boolean; intervalMinutes: number;
  codexWorkspaceDir: string; enableAIAssignment: boolean; enableAutoAssignment: boolean;
  requestDelayMs: number;
}
type ModelSettings = ReturnType<typeof loadAssignmentModelSettings>;
interface SchedulerState {
  enabled: boolean; lastSyncTime: string | null; nextRunAt: string | null;
  lastRunStatus: string; lastRunMessage: string;
}
interface RuntimeState {
  config: RuntimeConfig; assignmentPeople: AssignmentPerson[]; scheduler: SchedulerState;
  bugs: RuntimeIssue[]; storageUserKey: string;
}
interface Metrics { total: number; pending: number; processing: number; resolved: number; other: number; byStatus: Record<string, number> }
interface BatchResultItem { bugId: string; bugCode: string; ok: boolean; assigneeId?: string; assigneeName?: string; error?: string }
interface BatchSummary { ok: boolean; source: string; total: number; success: number; failed: number; results: BatchResultItem[] }
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));
const modelConnectionPath = '/api/config/model-connection';
const newConversationPath = /^\/api\/sessions\/([a-f0-9]{64})\/continue-as-new$/;
const continuationPath = /^\/api\/agent-sessions\/([a-f0-9]{64})\/continue$/;
const contextTransferPath = /^\/api\/conversations\/([a-f0-9]{64})\/transfer$/;
const contextTransferObjectPath = /^\/api\/conversations\/([a-f0-9]{64})\/transfer\/objects\/([a-f0-9]{64})$/;
// These routes coordinate through transactions or the specific resource they modify.
const independentWrites = new Set([
  modelConnectionPath,
  '/api/task-center',
  '/api/task-center/execute',
  '/api/task-center/execution-action',
  '/api/task-center/directory-picker',
  '/api/task-center/directory-action',
  '/api/task-center/git',
  '/api/task-center/git-action'
]);

export function createTenantRuntime({ database, tenant, environment, rootDir, deviceServicesFor, validateWorkspace = () => {} }: {
  database: Database; tenant: Tenant; environment: Environment; rootDir: string; deviceServicesFor?: (id: string) => DeviceServices; validateWorkspace?: (workspace: unknown) => void;
}) {
  const requestIdentity = new AsyncLocalStorage<Principal>();
  const mode = issueSourceId(environment);
  const storedSettings = database.readSettings(tenant.id);
  const { openaiApiKey: _legacyKey, openaiModelConnections: _connections, ...persistedConfig } = storedSettings.config;
  const modelDeployment = assignmentModelDeployment(environment);
  let modelSettings = loadAssignmentModelSettings(storedSettings.config, modelDeployment);
  let modelConnectionProbe: AbortController | undefined;
  const state: RuntimeState = {
    config: {
      mode,
      assignee: String(persistedConfig.assignee ?? ''),
      operatorId: String(persistedConfig.operatorId ?? ''),
      selfOnly: typeof persistedConfig.selfOnly === 'boolean' ? persistedConfig.selfOnly : false,
      ...issueSourceConfig({ environment, config: persistedConfig }),
      intervalMinutes: clampNumber(persistedConfig.intervalMinutes ?? environment.POLL_INTERVAL_MINUTES, 1, 240, 30),
      codexWorkspaceDir: environment.CODEX_WORKSPACE_DIR ? resolveWorkspaceDir(environment.CODEX_WORKSPACE_DIR) : (tenant.id === 'default' ? resolveWorkspaceDir(persistedConfig.codexWorkspaceDir || rootDir) : ''),
      enableAIAssignment: parseBooleanConfig(persistedConfig.enableAIAssignment, environment.ENABLE_AI_ASSIGNMENT, true),
      enableAutoAssignment: parseBooleanConfig(persistedConfig.enableAutoAssignment, environment.ENABLE_AUTO_ASSIGNMENT, false),
      requestDelayMs: clampNumber(persistedConfig.requestDelayMs, 0, 60000, 0)
    },
    assignmentPeople: normalizeAssignmentPeople(storedSettings.assignmentPeople, { fallback: [] }) as AssignmentPerson[],
    scheduler: { enabled: false, lastSyncTime: null, nextRunAt: null, lastRunStatus: 'idle', lastRunMessage: '尚未执行同步' },
    bugs: [],
    storageUserKey: ''
  };
  const issueStore = database.createStore(tenant.id);
  let schedulerTimer: ReturnType<typeof setInterval> | null = null, assignmentJobSeq = 0, assignmentBatchPromise: Promise<BatchSummary> | null = null, assignmentJobsPending = 0, mutationPending = false, closing = false;
  const activeAssignmentBugIds = new Set<string>();

  function loadIssueState(userKey: string) {
    const stored = issueStore.readUserState(userKey);
    state.storageUserKey = stored.userKey;
    state.bugs = stored.bugs as RuntimeIssue[];
  }
  loadIssueState(sourceStorageKey(issueSource(), resolveUserStorageKey(state.config)));

  async function persistIssueState(_options: { immediate?: boolean } = {}) {
    if (closing) return;
    await issueStore.writeUserState(state.storageUserKey, { bugs: state.bugs, updatedAt: new Date().toISOString() });
  }
  async function saveConfig(config: RuntimeConfig, models: ModelSettings) {
    const nextKey = sourceStorageKey(issueSource(config), resolveUserStorageKey(config));
    const switching = nextKey !== state.storageUserKey;
    if (switching) await persistIssueState();
    const stored = switching ? issueStore.readUserState(nextKey) : undefined;
    persistConfig(config, models);
    state.config = config;
    modelSettings = models;
    if (!stored) return;
    state.storageUserKey = stored.userKey;
    state.bugs = stored.bugs as RuntimeIssue[];
    state.scheduler.lastSyncTime = null;
    state.scheduler.lastRunStatus = 'idle';
    state.scheduler.lastRunMessage = '已切换经办人，等待同步';
  }
  function persistConfig(config: RuntimeConfig, models: ModelSettings) {
    database.writeSettings(tenant.id, { config: {
      ...issueSourceConfig({ environment, config }),
      assignee: config.assignee, operatorId: config.operatorId, selfOnly: config.selfOnly,
      intervalMinutes: config.intervalMinutes, codexWorkspaceDir: config.codexWorkspaceDir,
      enableAIAssignment: config.enableAIAssignment, enableAutoAssignment: config.enableAutoAssignment,
      ...storedAssignmentModelSettings(models)
    }});
  }
  async function persistAssignmentPeople() {
    database.writeSettings(tenant.id, { assignmentPeople: normalizeAssignmentPeople(state.assignmentPeople, { fallback: [] }) });
  }

  function workFor(kind: DeviceWorkKind, id: unknown, actor: { id: string }, deviceId?: string, bound = requestIdentity.getStore()?.connectorDeviceId) {
    const route = bound === '' || (deviceId && bound && deviceId !== bound) ? undefined
      : sharedWorkRoute(database, tenant.id, actor.id, kind, id, deviceId ?? bound);
    if (!route) return { services: deviceServices, actor, tenantId: tenant.id };
    if (!deviceServicesFor) throw httpError(503, '团队设备服务暂不可用');
    return { services: deviceServicesFor(route.tenantId), actor: { id: route.memberId, sharedDeviceId: route.deviceId }, tenantId: route.tenantId };
  }
  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const readDeviceCommand = async (limit?: number) => {
      const body = await readJson(req, limit);
      if (requestIdentity.getStore()?.scope === 'connector' && !connectorActionAllowed(url.pathname, body.action)) throw httpError(403, '设备会话只能同步设备状态或领取、回报执行');
      return body;
    };
    if (url.pathname === '/api/search' && req.method === 'GET') {
      const q = searchQuery(url.searchParams), scope = url.searchParams.get('scope');
      if (scope !== 'tasks' && scope !== 'bugs') { sendJson(res, 400, { error: 'invalid_search_scope', message: '搜索范围必须为 tasks 或 bugs' }); return; }
      const documents = () => scope === 'tasks' ? taskSearchDocuments(database.readTaskCenter(tenant.id)) : bugSearchDocuments(state.bugs);
      const before = documents(), context = state.storageUserKey;
      const result = await vectorSearch.search(scope, q, before);
      // Recheck visibility after model I/O; config/sync/delete requests can run meanwhile.
      const current = new Map(documents().map(doc => [doc.id, doc.text]));
      const unchanged = new Set(before.filter(doc => current.get(doc.id) === doc.text).map(doc => doc.id));
      sendJson(res, 200, { ...result, ids: scope === 'bugs' && context !== state.storageUserKey ? [] : result.ids.filter(id => unchanged.has(id)) }); return;
    }
    const collaboration = collaborationRoute(req.method, url.pathname);
    if (collaboration) {
      const actor = requestIdentity.getStore()!.user;
      switch (collaboration.action) {
        case 'list': sendJson(res, 200, collaborations.list()); return;
        case 'detail': sendJson(res, 200, collaborations.detail(collaboration.id)); return;
        case 'create': sendJson(res, 201, await collaborations.create(await readJson(req), actor)); return;
        case 'publish': sendJson(res, 201, collaborations.publish(collaboration.id, await readJson(req), actor)); return;
        case 'run': sendJson(res, 202, await collaborations.run(collaboration.id, await readJson(req), actor)); return;
      }
    }
    if (url.pathname === '/api/workspaces/chats' && req.method === 'GET') { sendJson(res, 200, groupChats.list()); return; }
    if (url.pathname === '/api/workspaces/chats' && req.method === 'POST') { sendJson(res, 201, await groupChats.create(await readJson(req), requestIdentity.getStore()!.user)); return; }
    const chat = /^\/api\/workspaces\/chats\/([a-f0-9-]{36})(?:\/(messages|stop))?$/.exec(url.pathname);
    if (chat && !chat[2] && req.method === 'GET') { sendJson(res, 200, groupChats.detail(chat[1])); return; }
    if (chat && chat[2] && req.method === 'POST') {
      const input = await readJson(req), actor = requestIdentity.getStore()!.user;
      sendJson(res, 200, chat[2] === 'messages' ? groupChats.send(chat[1], input, actor) : await groupChats.stop(chat[1], input, actor)); return;
    }
    if (url.pathname === '/api/task-center/device-state' && req.method === 'GET') {
      sendJson(res, 200, deviceControl.snapshot(url.searchParams, requestIdentity.getStore()!.user.id, requestIdentity.getStore()?.connectorDeviceId)); return;
    }
    if (url.pathname === '/api/task-center/device-updates' && req.method === 'GET') {
      await deviceControl.serve(req, res, url.searchParams, requestIdentity.getStore()!.user.id); return;
    }
    if (url.pathname === '/api/task-center/changes' && req.method === 'GET') {
      sendJson(res, 200, await taskCenter.changes(taskCenterSince(url.searchParams))); return;
    }
    if (url.pathname === '/api/task-center/updates' && req.method === 'GET') {
      await taskCenterStream.serve(req, res, url.searchParams); return;
    }
    const newConversation = newConversationPath.exec(url.pathname);
    if (newConversation && req.method === 'POST') { sendJson(res, 202, await conversations.create(newConversation[1], await readJson(req), requestIdentity.getStore()!.user)); return; }
    if (url.pathname === '/api/conversations' && req.method === 'GET') { sendJson(res, 200, { sessions: conversations.list() }); return; }
    const inherited = /^\/api\/conversations\/([a-f0-9]{64})\/inherited$/.exec(url.pathname);
    if (inherited && req.method === 'GET') {
      const target = workFor('sourceContext', inherited[1], requestIdentity.getStore()!.user);
      sendJson(res, 200, target.services.conversations.inherited(inherited[1], url.searchParams)); return;
    }
    const contextPreview = /^\/api\/conversations\/([a-f0-9]{64})\/context-preview$/.exec(url.pathname);
    if (contextPreview && req.method === 'GET') { sendJson(res, 200, conversations.contextPreview(contextPreview[1], url.searchParams)); return; }
    const transferObject = contextTransferObjectPath.exec(url.pathname);
    if (transferObject && ['GET', 'POST'].includes(req.method || '')) {
      const executionId = url.searchParams.get('executionId') || '';
      if (!/^[a-f0-9-]{36}$/.test(executionId)) throw Object.assign(new Error('执行标识无效'), { statusCode: 400 });
      const action = req.method === 'POST' ? 'upload' : 'read';
      const bytes = action === 'upload' ? await readBytes(req, 12 * 1024 * 1024) : undefined;
      const target = workFor(action === 'upload' ? 'transferSource' : 'transferTarget', executionId, requestIdentity.getStore()!.user, url.searchParams.get('deviceId') || '');
      const result = target.services.conversations.transferObject(transferObject[1], executionId, action, target.actor,
        { deviceId: url.searchParams.get('deviceId'), digest: transferObject[2], mimeType: url.searchParams.get('mimeType') || '',
          ...(bytes ? { data: bytes } : {}) });
      if (action === 'read' && 'bytes' in result) {
        res.writeHead(200, { 'Content-Type': result.mimeType, 'Content-Length': result.bytes.byteLength, 'Cache-Control': 'no-store' });
        res.end(Buffer.from(result.bytes));
      } else sendJson(res, 200, result);
      return;
    }
    const transfer = contextTransferPath.exec(url.pathname);
    if (transfer && ['GET', 'POST'].includes(req.method || '')) {
      const body = req.method === 'POST' ? await readJson(req, 85_000_000) : { executionId: url.searchParams.get('executionId'), deviceId: url.searchParams.get('deviceId'), readyOnly: url.searchParams.get('readyOnly'), format: url.searchParams.get('format') };
      if (typeof body.executionId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.executionId)) throw Object.assign(new Error('执行标识无效'), { statusCode: 400 });
      const target = workFor(req.method === 'POST' ? 'transferSource' : 'transferTarget', body.executionId, requestIdentity.getStore()!.user, String(body.deviceId || ''));
      sendJson(res, 200, target.services.conversations.transfer(transfer[1], body.executionId, req.method === 'POST' ? 'upload' : 'read', target.actor, body)); return;
    }
    if (url.pathname === '/api/task-center/git') {
      const actor = requestIdentity.getStore()!.user;
      if (req.method === 'GET') { sendJson(res, 200, remoteGit.status(url.searchParams.get('requestId') || '', actor)); return; }
      const input = await readJson(req);
      sendJson(res, 200, input.deviceId && input.deviceId !== 'local' ? remoteGit.submit(input, actor) : await codexExecution.git(input)); return;
    }
    if (url.pathname === '/api/task-center/git-action' && req.method === 'POST') {
      const input = await readDeviceCommand(), target = workFor('git', input.requestId, requestIdentity.getStore()!.user);
      sendJson(res, 200, target.services.git.action(input, target.actor)); return;
    }
    if (url.pathname === '/api/task-center/directory-picker') {
      const actor = requestIdentity.getStore()!.user;
      sendJson(res, 200, req.method === 'GET' ? codexExecution.directoryStatus({ requestId: url.searchParams.get('requestId') || undefined }, actor) : await codexExecution.pickDirectory(await readJson(req), actor)); return;
    }
    if (url.pathname === '/api/task-center/directory-action') {
      const input = await readDeviceCommand(), target = workFor('directory', input.requestId, requestIdentity.getStore()!.user);
      sendJson(res, 200, target.services.execution.directoryAction(input, target.actor)); return;
    }
    if (url.pathname === '/api/task-center/codex') { sendJson(res, 200, await codexExecution.targets({ visibleOnly: true })); return; }
    if (url.pathname === '/api/task-center/execute') { sendJson(res, 202, await codexExecution.execute(await readJson(req, 15_000_000), requestIdentity.getStore()!.user)); return; }
    if (url.pathname === '/api/task-center/execution-action') {
      const input = await readDeviceCommand(8_000_000), actor = requestIdentity.getStore()!.user;
      const target = connectorActionAllowed(url.pathname, input.action) ? workFor(input.action === 'report' ? 'report' : 'execution', input.executionId, actor) : { services: deviceServices, actor };
      sendJson(res, 200, await target.services.execution.action(input, target.actor)); return;
    }
    if (url.pathname === '/api/task-center') {
      const principal = requestIdentity.getStore()!;
      if (req.method === 'GET' && principal.scope === 'connector') {
        sendJson(res, 200, deviceControl.syncSnapshot(principal.user.id, principal.connectorDeviceId)); return;
      }
      if (req.method === 'GET') { sendJson(res, 200, await taskCenter.snapshot()); return; }
      const input = await readDeviceCommand();
      const target = input.action === 'ack' && input.status === 'received' ? workFor('handoff', input.handoffId, principal.user) : { services: deviceServices, actor: principal.user };
      if (input.action === 'heartbeat' && principal.connectorDeviceId && principal.connectorDeviceId !== input.deviceId) throw httpError(403, '连接器凭据属于其他设备');
      const bind = input.action === 'heartbeat' && principal.connectorDeviceId === ''
        ? (id: string) => database.bindConnectorDevice((req.headers.authorization || '').slice(7), id) : undefined;
      sendJson(res, 200, await target.services.taskCenter.command(input, target.actor, bind)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/task-center/history-images') {
      sendJson(res, 200, historyImages.upload(await readJson(req, 17_000_000), requestIdentity.getStore()!.user)); return;
    }
    const historyImage = /^\/api\/agent-sessions\/([a-f0-9]{64})\/images(?:\/([a-f0-9]{64}))?$/.exec(url.pathname);
    if (req.method === 'GET' && historyImage) {
      sendJson(res, 200, historyImage[2] ? historyImages.read(historyImage[1], historyImage[2]) : historyImages.list(historyImage[1], url.searchParams)); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') { sendJson(res, 200, await sessionDelivery.list(url.searchParams)); return; }
    const delivery = /^\/api\/sessions\/([a-f0-9]{64})(?:\/(events|records))?$/.exec(url.pathname);
    if (req.method === 'GET' && delivery) {
      const result = delivery[2] === 'records' ? await sessionDelivery.record(delivery[1], url.searchParams) : delivery[2] === 'events' ? await sessionDelivery.events(delivery[1], url.searchParams) : await sessionDelivery.detail(delivery[1], url.searchParams);
      sendJson(res, 200, result); return;
    }
    const continuation = continuationPath.exec(url.pathname);
    if (continuation && req.method === 'POST') { sendJson(res, 202, conversations.has(continuation[1]) ? await conversations.send(continuation[1], await readJson(req)) : await codexExecution.continueHistory(continuation[1], await readJson(req))); return; }
    if (continuation && req.method === 'GET') { sendJson(res, 200, conversations.has(continuation[1]) ? conversations.status(continuation[1]) : await codexExecution.historyExecution(continuation[1])); return; }
    if (req.method === 'GET' && url.pathname === '/api/agent-sessions') { sendJson(res, 200, await conversations.historyList(url.searchParams)); return; }
    const history = /^\/api\/agent-sessions\/([a-f0-9]{64})$/.exec(url.pathname);
    if (req.method === 'GET' && history) { sendJson(res, 200, conversations.has(history[1]) ? conversations.detail(history[1], url.searchParams) : conversations.remoteDetail(history[1], url.searchParams) || await agentHistory.detail(history[1], url.searchParams)); return; }
    if (req.method === 'GET' && url.pathname === '/api/bootstrap') { sendJson(res, 200, getBootstrap()); return; }
    if (req.method === 'GET' && url.pathname === '/api/assignment/people') { sendJson(res, 200, { people: state.assignmentPeople }); return; }
    if (req.method === 'PUT' && url.pathname === '/api/assignment/people') {
      state.assignmentPeople = normalizeAssignmentPeople(await readJson(req), { fallback: [] }); await persistAssignmentPeople(); sendJson(res, 200, getBootstrap()); return;
    }
    if (req.method === 'PUT' && url.pathname === '/api/config') {
      if (hasBackgroundWork()) { sendJson(res, 409, { error: 'tenant_busy', message: '当前账号有后台任务执行中，请稍后修改配置' }); return; }
      const body = await readJson(req);
      validateWorkspace(body.codexWorkspaceDir ?? state.config.codexWorkspaceDir);
      const models = updateAssignmentModelSettings(modelSettings, body);
      const { openaiApiKey: _key, openaiModelConnections: _connections, ...settings } = body;
      await saveConfig(nextConfig(settings), models);
      configureScheduler(state.scheduler.enabled);
      sendJson(res, 200, getBootstrap()); return;
    }
    if (req.method === 'POST' && url.pathname === modelConnectionPath) {
      const input = await readJson(req, 16_384);
      if (res.destroyed) return;
      if (modelConnectionProbe) throw httpError(409, '正在测试模型连接，请稍后再试');
      const { baseUrl, model, apiKey, timeoutMs } = assignmentModelProbe(modelSettings, modelDeployment, input);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const { signal } = controller;
      const timeout = setTimeout(() => controller.abort(new DOMException('模型服务连接超时', 'TimeoutError')), timeoutMs).unref();
      modelConnectionProbe = controller;
      res.once('close', cancel);
      try {
        const payload = await requestAssignmentModel(baseUrl, apiKey, {
          model, store: false, input: 'Return a JSON object with ok set to true.',
          text: { format: { type: 'json_schema', name: 'connection_test', strict: true,
            schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } }
        }, signal);
        const text = assignmentResponseText(payload);
        let output: unknown;
        try { output = JSON.parse(text); }
        catch { throw httpError(502, '模型服务未返回有效的测试结果'); }
        if (!output || typeof output !== 'object' || !('ok' in output) || output.ok !== true) throw httpError(502, '模型服务未返回有效的测试结果');
        sendJson(res, 200, { ok: true });
      } catch (error: unknown) {
        throw assignmentModelError(error, signal);
      } finally {
        clearTimeout(timeout);
        res.off('close', cancel);
        modelConnectionProbe = undefined;
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/sync') {
      if (assignmentJobsPending || assignmentBatchPromise) { sendJson(res, 409, { error: 'tenant_busy', message: 'AI 分配任务执行中，请稍后同步' }); return; }
      const result = await syncBugs({ incremental: false }); sendJson(res, result.ok ? 200 : 400, result); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/issues/diagnostics') { sendJson(res, 200, { checks: await issueSource().diagnose() }); return; }
    const attachment = url.pathname.match(/^\/api\/bugs\/([^/]+)\/attachments$/);
    if (req.method === 'GET' && attachment) {
      const bug = findBug(decodeURIComponent(attachment[1])); if (!bug) return sendJson(res, 404, { error: 'bug_not_found', message: '缺陷不存在' });
      await ensureBugAttachmentsLoaded(bug); sendJson(res, 200, { bugId: bug.id, attachments: bug.attachments || [] }); return;
    }
    const recommend = url.pathname.match(/^\/api\/bugs\/([^/]+)\/assignment\/recommend$/);
    if (req.method === 'POST' && recommend) {
      const bug = findBug(decodeURIComponent(recommend[1])); if (!bug) return sendJson(res, 404, { error: 'bug_not_found', message: '缺陷不存在' });
      await ensureBugAttachmentsLoaded(bug); bug.assignmentRecommendation = await recommendBugAssignee(bug); await persistIssueState();
      sendJson(res, 200, { bug, recommendation: bug.assignmentRecommendation }); return;
    }
    const taskRoute = url.pathname.match(/^\/api\/bugs\/([^/]+)\/task$/);
    if (req.method === 'POST' && taskRoute) {
      const bug = findBug(decodeURIComponent(taskRoute[1])); if (!bug) return sendJson(res, 404, { error: 'bug_not_found', message: '缺陷不存在' });
      const existing = (await taskCenter.snapshot()).tasks.find((task) => task.source?.type === 'defect' && task.source.id === bug.id);
      if (existing) return sendJson(res, 200, { taskId: existing.id, revision: existing.revision, existing: true });
      await ensureBugAttachmentsLoaded(bug);
      const result = await taskCenter.command({ action: 'create', title: `[${bug.code || bug.id}] ${bug.title}`.slice(0, 120), source: { type: 'defect', id: bug.id, code: bug.code || '' }, content: taskContent({ context: defectTaskContext(bug) }) }, requestIdentity.getStore()!.user);
      sendJson(res, 201, { ...result, existing: false }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/assignments/apply-all') {
      const result = await applyReadyAssignments({ source: 'manual-batch' }); sendJson(res, 200, { result, ...getBootstrap() }); return;
    }
    const apply = url.pathname.match(/^\/api\/bugs\/([^/]+)\/assignment\/apply$/);
    if (req.method === 'POST' && apply) {
      const bug = findBug(decodeURIComponent(apply[1])); if (!bug) return sendJson(res, 404, { error: 'bug_not_found', message: '缺陷不存在' });
      try { const result = await applyBugAssignment(bug, await readJson(req)); await persistIssueState(); sendJson(res, 200, { bug, result }); }
      catch (error: unknown) { bug.assignmentRecommendation = { ...(bug.assignmentRecommendation || {}), status: 'assign-failed', assigned: false, error: sanitizeError(error), failedAt: new Date().toISOString() }; await persistIssueState(); sendJson(res, 400, { error: 'assignment_failed', message: sanitizeError(error), bug }); }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/scheduler') {
      state.scheduler.enabled = Boolean((await readJson(req)).enabled); configureScheduler(state.scheduler.enabled); sendJson(res, 200, getBootstrap()); return;
    }
    sendJson(res, 404, { error: 'not_found', message: '接口不存在' });
  }

  function findBug(id: string) { return state.bugs.find((item) => item.id === id || item.aid === id); }
  function getBootstrap() {
    const principal = requestIdentity.getStore();
    const source = issueSource();
    return {
      ...(principal ? publicIdentity(principal) : {}),
      tenant: { id: tenant.id, name: tenant.name }, storage: { driver: 'postgres', schemaVersion: 3 },
      search: { vectorEnabled: vectorSearchEnabled(environment) },
      config: {
        ...state.config,
        ...publicAssignmentModelSettings(modelSettings, modelDeployment),
        workspaceManaged: Boolean(environment.CODEX_WORKSPACE_DIR) || database.listTenants().length > 1,
        issueSourceLabel: source.label, issueSourceConfigured: source.configured
      },
      scheduler: state.scheduler, assignmentPeople: state.assignmentPeople, storageUserKey: state.storageUserKey,
      bugs: state.bugs, metrics: buildMetrics()
    };
  }
  function buildMetrics() {
    const metrics: Metrics = { total: state.bugs.length, pending: 0, processing: 0, resolved: 0, other: 0, byStatus: {} };
    for (const bug of state.bugs) { const key = statusGroupOf(bug.status); metrics[key]++; const status = bug.status || '未知'; metrics.byStatus[status] = (metrics.byStatus[status] || 0) + 1; }
    return metrics;
  }
  function statusGroupOf(status: unknown): 'pending' | 'processing' | 'resolved' | 'other' {
    const value = String(status || '').toLowerCase();
    if (/待处理|未处理|待受理|待确认|待分配|open|new|todo|pending|onaudit/.test(value)) return 'pending';
    if (/处理中|处理|进行中|修复中|in progress|doing|processing|develop|fix/.test(value)) return 'processing';
    if (/已解决|已关闭|已完成|关闭|解决|完成|resolved|closed|done|finish/.test(value)) return 'resolved';
    return 'other';
  }
  function isAssignableBugStatus(status: unknown) { return ['pending', 'processing'].includes(statusGroupOf(status)); }
  function defectTaskContext(bug: RuntimeIssue) {
    const steps = Array.isArray(bug.reproduceSteps) ? bug.reproduceSteps : [];
    const facts = [`缺陷编码：${bug.code || bug.id}`, `标题：${bug.title || '未填写'}`, `状态：${bug.status || '未知'}`, `优先级：${bug.priority || bug.severity || '未填写'}`, bug.description ? `描述：${bug.description}` : '', steps.length ? `复现步骤：\n${steps.map((step, index) => `${index + 1}. ${typeof step === 'string' ? step : JSON.stringify(step)}`).join('\n')}` : '', bug.expected ? `预期结果：${bug.expected}` : '', bug.actual ? `实际结果：${bug.actual}` : ''].filter(Boolean);
    return { goal: `修复缺陷 ${bug.code || bug.id}：${bug.title || ''}`, constraints: facts.join('\n\n'), decisions: '此任务直接来源于缺陷工作台，缺陷原始信息作为任务上下文。', next: '分析并复现缺陷，完成修复与必要测试，汇报验证结果。', files: (bug.attachments || []).map((item) => `- ${item.name || '附件'}：${item.url || '无链接'}`).join('\n') };
  }
function startAssignmentRecommendationsForBugs(bugs: RuntimeIssue[]) {
  const jobId = ++assignmentJobSeq;
  if (!state.config.enableAIAssignment) {
    for (const bug of bugs) {
      bug.assignmentRecommendation = {
        status: "skipped",
        source: "disabled",
        reason: "配置已关闭 AI 自动分配建议。",
        createdAt: new Date().toISOString()
      };
    }
    state.scheduler.lastRunMessage = `${state.scheduler.lastRunMessage}；AI 分配建议已关闭`;
    return jobId;
  }

  for (const bug of bugs) {
    if (isAssignableBugStatus(bug.status)) {
      bug.assignmentRecommendation = {
        status: "pending",
        source: "model",
        reason: "AI 分配建议后台生成中。",
        createdAt: new Date().toISOString()
      };
    } else {
      bug.assignmentRecommendation = {
        status: "skipped",
        source: "status-filter",
        reason: `仅待处理和处理中的缺陷需要分配，当前状态为：${bug.status || "未知"}。`,
        createdAt: new Date().toISOString()
      };
    }
  }

  assignmentJobsPending += 1;
  runAssignmentRecommendationJob(jobId).catch((error) => {
    console.warn(`[ai-assignment] background job failed: ${sanitizeError(error)}`);
  }).finally(() => { assignmentJobsPending -= 1; });
  return jobId;
}

async function runAssignmentRecommendationJob(jobId: number) {
  for (const bug of state.bugs) {
    if (jobId !== assignmentJobSeq) return;
    if (bug.assignmentRecommendation?.status !== "pending") continue;
    bug.assignmentRecommendation = await recommendBugAssignee(bug);
  }

  if (jobId !== assignmentJobSeq) return;
  const assignmentReady = state.bugs.filter((bug) => bug.assignmentRecommendation?.status === "ready").length;
  const assignmentFailed = state.bugs.filter((bug) => bug.assignmentRecommendation?.status === "error").length;
  if (state.config.enableAutoAssignment && assignmentReady > 0) {
    const batch = await applyReadyAssignments({ source: "auto" });
    state.scheduler.lastRunMessage = `AI 分配建议已完成；自动分配成功 ${batch.success} 条${batch.failed ? `，失败 ${batch.failed} 条` : ""}`;
  } else {
    state.scheduler.lastRunMessage = `AI 分配建议已完成：成功 ${assignmentReady} 条${assignmentFailed ? `，失败 ${assignmentFailed} 条` : ""}`;
  }
  await persistIssueState({ immediate: true });
}

async function recommendBugAssignee(bug: RuntimeIssue): Promise<AssignmentRecommendation> {
  if (!state.assignmentPeople.length) {
    return { status: "skipped", source: "unconfigured", reason: "请先为当前团队配置分配人员。", createdAt: new Date().toISOString() };
  }
  if (!isAssignableBugStatus(bug.status)) {
    return {
      status: "skipped",
      source: "status-filter",
      reason: `仅待处理和处理中的缺陷需要分配，当前状态为：${bug.status || "未知"}。`,
      createdAt: new Date().toISOString()
    };
  }

  const { model } = modelSettings;
  const connection = assignmentConnectionFor(modelSettings);
  const apiKey = connection && assignmentConnectionKey(connection, modelDeployment);
  if (!connection || !apiKey) {
    return {
      status: "error",
      source: "model",
      error: connection ? "当前模型地址未配置 OpenAI API Key，无法生成 AI 分配建议。" : "请选择已绑定 Base URL 的 AI 分配模型。",
      createdAt: new Date().toISOString()
    };
  }

  const signal = AbortSignal.timeout(connection.timeoutMs);
  console.info(`[ai-assignment] request ${JSON.stringify({
    bugCode: bug.code || bug.id || "unknown",
    model,
    peopleCount: state.assignmentPeople.length
  })}`);

  try {
    const payload = await requestAssignmentModel(connection.baseUrl, apiKey, {
      model,
      input: [
        { role: "system", content: buildAssignmentSystemPrompt(state.assignmentPeople) },
        { role: "user", content: JSON.stringify(buildAssignmentUserPayload(bug, state.assignmentPeople)) }
      ],
      text: { format: { type: "json_schema", name: "bug_assignment", strict: true, schema: buildAssignmentJsonSchema(state.assignmentPeople) } }
    }, signal);
    const text = assignmentResponseText(payload);
    let output: unknown;
    try { output = JSON.parse(text); }
    catch { throw httpError(502, '模型服务未返回有效的分配建议'); }

    const recommendation = applyAssignmentBusinessRules(
      bug,
      normalizeAssignmentRecommendation(output, { model, people: state.assignmentPeople }),
      state.assignmentPeople
    );
    recommendation.reason = recommendation.reason.replaceAll(apiKey, '[redacted]');
    recommendation.matchedResponsibility = recommendation.matchedResponsibility.replaceAll(apiKey, '[redacted]');
    console.info(`[ai-assignment] result bug=${bug.code || bug.id || "unknown"} ${JSON.stringify({
      assigneeId: recommendation.assigneeId,
      assigneeName: recommendation.assigneeName,
      confidence: recommendation.confidence,
      reason: recommendation.reason
    })}`);
    return recommendation;
  } catch (error: unknown) {
    const message = assignmentModelError(error, signal).message;
    console.warn(`[ai-assignment] error bug=${bug.code || bug.id || "unknown"} ${message}`);
    return {
      status: "error",
      source: "model",
      model,
      error: message,
      createdAt: new Date().toISOString()
    };
  }
}

async function applyBugAssignment(bug: RuntimeIssue, body: { assigneeId?: unknown } = {}) {
  const assignmentKey = String(bug.id || bug.aid || bug.code || "");
  if (activeAssignmentBugIds.has(assignmentKey)) {
    throw new Error("当前缺陷正在分配，请稍后刷新查看结果。");
  }

  activeAssignmentBugIds.add(assignmentKey);
  try {
    return await applyBugAssignmentUnlocked(bug, body);
  } finally {
    activeAssignmentBugIds.delete(assignmentKey);
  }
}

async function applyBugAssignmentUnlocked(bug: RuntimeIssue, body: { assigneeId?: unknown } = {}) {
  issueSource().validate();
  if (!isAssignableBugStatus(bug.status)) {
    throw new Error(`仅待处理和处理中的缺陷允许分配，当前状态为：${bug.status || "未知"}。`);
  }

  const recommendation = bug.assignmentRecommendation;
  const targetAssignee = String(body.assigneeId || recommendation?.assigneeId || "").trim();
  if (!targetAssignee) {
    throw new Error("缺少目标经办人 ID，请先生成分配建议。");
  }

  const result = await issueSource().assign(bug, targetAssignee);

  bug.assignee = recommendation?.assigneeName || targetAssignee;
  bug.assigneeId = targetAssignee;
  bug.assignmentRecommendation = {
    ...(recommendation || {}),
    status: "assigned",
    assigned: true,
    assignedAt: new Date().toISOString(),
    assignmentOperation: {
      operationCode: issueSource().assignmentOperationCode,
      operationName: "更新问题经办人"
    },
    assignmentResult: result
  };

  return {
    ok: true,
    assigneeId: targetAssignee,
    operationCode: issueSource().assignmentOperationCode,
    operationName: "更新问题经办人",
    providerResult: result
  };
}

async function applyReadyAssignments({ source = "manual-batch" }: { source?: string } = {}): Promise<BatchSummary> {
  if (assignmentBatchPromise) return assignmentBatchPromise;

  assignmentBatchPromise = runReadyAssignmentBatch({ source });
  try {
    return await assignmentBatchPromise;
  } finally {
    assignmentBatchPromise = null;
  }
}

async function runReadyAssignmentBatch({ source }: { source: string }): Promise<BatchSummary> {
  const candidates = state.bugs.filter((bug) => isAssignmentCandidate(bug, isAssignableBugStatus));
  const results: BatchResultItem[] = [];

  for (const [index, bug] of candidates.entries()) {
    const recommendation = bug.assignmentRecommendation!;
    bug.assignmentRecommendation = {
      ...recommendation,
      status: "assigning",
      error: ""
    };

    try {
      const result = await applyBugAssignment(bug, { assigneeId: recommendation.assigneeId });
      results.push({
        bugId: bug.id,
        bugCode: bug.code,
        ok: true,
        assigneeId: result.assigneeId,
        assigneeName: bug.assignee
      });
    } catch (error: unknown) {
      const message = sanitizeError(error);
      bug.assignmentRecommendation = {
        ...(bug.assignmentRecommendation || recommendation),
        status: "assign-failed",
        assigned: false,
        error: message,
        failedAt: new Date().toISOString()
      };
      results.push({
        bugId: bug.id,
        bugCode: bug.code,
        ok: false,
        assigneeId: recommendation.assigneeId,
        assigneeName: recommendation.assigneeName,
        error: message
      });
    }

    if (index < candidates.length - 1 && state.config.requestDelayMs > 0) {
      await sleep(state.config.requestDelayMs);
    }
  }

  const success = results.filter((item) => item.ok).length;
  const failed = results.length - success;
  const summary: BatchSummary = {
    ok: failed === 0,
    source,
    total: candidates.length,
    success,
    failed,
    results
  };

  await persistIssueState({ immediate: true });
  return summary;
}

async function ensureBugAttachmentsLoaded(bug: RuntimeIssue) {
  if (bug.attachmentsLoaded) return;

  try {
    const attachments = await issueSource().attachments(bug);

    bug.attachments = attachments;
    bug.attachmentsLoaded = true;
    bug.attachmentsError = "";
  } catch (error: unknown) {
    bug.attachments = bug.attachments || [];
    bug.attachmentsLoaded = false;
    bug.attachmentsError = sanitizeError(error);
  }
}


  function resolveUserStorageKey(config: Partial<RuntimeConfig> = {}) {
    const value = String(config.assignee || (config.selfOnly && config.operatorId) || config.operatorId || 'default').trim().toLowerCase();
    return value.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'default';
  }
  function nextConfig(next: JsonObject): RuntimeConfig {
    return {
      ...state.config, mode, ...issueSourceConfig({ environment, config: state.config }, next),
      assignee: stringConfig(next, 'assignee', state.config.assignee), operatorId: stringConfig(next, 'operatorId', state.config.operatorId),
      selfOnly: booleanConfig(next, 'selfOnly', state.config.selfOnly), intervalMinutes: numberConfig(next, 'intervalMinutes', 1, 240, state.config.intervalMinutes),
      codexWorkspaceDir: stringConfig(next, 'codexWorkspaceDir', state.config.codexWorkspaceDir) ? resolveWorkspaceDir(stringConfig(next, 'codexWorkspaceDir', state.config.codexWorkspaceDir)) : '',
      enableAIAssignment: booleanConfig(next, 'enableAIAssignment', state.config.enableAIAssignment),
      enableAutoAssignment: booleanConfig(next, 'enableAutoAssignment', state.config.enableAutoAssignment)
    };
  }
  function hasOwn(object: JsonObject, key: string) { return Object.prototype.hasOwnProperty.call(object, key); }
  function stringConfig(object: JsonObject, key: string, fallback: string) { return hasOwn(object, key) ? String(object[key] ?? '').trim() : fallback; }
  function booleanConfig(object: JsonObject, key: string, fallback: boolean) { return typeof object[key] === 'boolean' ? object[key] : fallback; }
  function numberConfig(object: JsonObject, key: string, min: number, max: number, fallback: number) { return hasOwn(object, key) ? clampNumber(object[key], min, max, fallback) : fallback; }
  async function syncBugs({ incremental = false }: { incremental?: boolean } = {}) {
    state.scheduler.lastRunStatus = 'running'; state.scheduler.lastRunMessage = '正在同步缺陷';
    try {
      const source = issueSource(), startedAt = new Date(), bugs = await source.sync({ lastSyncTime: incremental ? state.scheduler.lastSyncTime : null });
      state.bugs = incremental ? mergeBugs(state.bugs, bugs) : bugs;
      startAssignmentRecommendationsForBugs(state.bugs);
      state.scheduler.lastRunMessage = `${source.label} 同步完成，获取 ${bugs.length} 条缺陷；AI 分配建议后台生成中`;
      state.scheduler.lastRunStatus = 'success'; state.scheduler.lastSyncTime = syncCheckpoint(source, startedAt); state.scheduler.nextRunAt = nextRunIso();
      await persistIssueState(); return { ok: true, ...getBootstrap() };
    } catch (error: unknown) {
      state.scheduler.lastRunStatus = 'error'; state.scheduler.lastRunMessage = sanitizeError(error); state.scheduler.nextRunAt = nextRunIso();
      return { ok: false, message: state.scheduler.lastRunMessage, ...getBootstrap() };
    }
  }
  function issueSource(config = state.config) { return createIssueSource({ config, environment }); }
  function configureScheduler(enabled: boolean) {
    if (schedulerTimer) clearInterval(schedulerTimer); schedulerTimer = null;
    if (!enabled) { state.scheduler.nextRunAt = null; return; }
    state.scheduler.nextRunAt = nextRunIso();
    schedulerTimer = setInterval(() => {
      if (mutationPending || hasBackgroundWork()) return;
      mutationPending = true; syncBugs({ incremental: true }).catch((error) => { state.scheduler.lastRunStatus = 'error'; state.scheduler.lastRunMessage = sanitizeError(error); }).finally(() => { mutationPending = false; });
    }, state.config.intervalMinutes * 60 * 1000);
  }
  function mergeBugs(current: RuntimeIssue[], updates: WorkIssue[]): RuntimeIssue[] {
    const byId = new Map<string, RuntimeIssue>(current.map((bug) => [bug.id, bug]));
    for (const bug of updates) byId.set(bug.id, { ...byId.get(bug.id), ...bug } as RuntimeIssue);
    return [...byId.values()].sort((a, b) => Date.parse(b.updatedAt || '0') - Date.parse(a.updatedAt || '0'));
  }
  function sendJson(res: ServerResponse, status: number, data: unknown) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
  function clampNumber(value: unknown, min: number, max: number, fallback: number) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; }
  function parseBooleanConfig(persisted: unknown, env: unknown, fallback: boolean) { if (typeof persisted === 'boolean') return persisted; return typeof env === 'string' ? /^(true|1|yes|on)$/i.test(env.trim()) : fallback; }
  function resolveWorkspaceDir(value: unknown) { const raw = String(value || '').trim(); return raw ? path.resolve(rootDir, raw) : rootDir; }
  function nextRunIso() { return new Date(Date.now() + state.config.intervalMinutes * 60 * 1000).toISOString(); }
  function sleep(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))); }
  function sanitizeError(error: unknown) {
    let message = asError(error).message; for (const key of Object.keys(environment).filter((key) => /KEY|SECRET|TOKEN|COOKIE/.test(key))) if (environment[key]) message = message.split(environment[key]!).join('[redacted]');
    return message;
  }
  function hasBackgroundWork() { return assignmentJobsPending > 0 || Boolean(assignmentBatchPromise) || activeAssignmentBugIds.size > 0; }

  const vectorSearch = createVectorSearch({ store: database.searchVectors, tenantId: tenant.id, environment });
  const agentHistory = createAgentHistory({ environment, tenantId: tenant.id, rootDir, workspace: () => state.config.codexWorkspaceDir });
  const sessionDelivery = createSessionDelivery({ history: agentHistory, environment });
  const taskCenter = createTaskCenter({ database, tenantId: tenant.id, history: agentHistory, environment });
  const taskCenterStream = createTaskCenterStream(database, tenant.id);
  const deviceControl = createDeviceControl(database, tenant.id);
  const codexExecution = createCodexExecution({ database, attachmentRoot: path.join(rootDir, '.workflow-data', 'attachments', createHash('sha256').update(tenant.id).digest('hex')), tenantId: tenant.id, workspace: () => state.config.codexWorkspaceDir, history: agentHistory, environment });
  const remoteGit = createRemoteGit(database, tenant.id);
  const historyImages = createHistoryImages(database, tenant.id);
  const summaryConnection = modelSettings.connections.find(connection => connection.baseUrl === modelDeployment.baseUrl);
  const summaryModel = environment.CONTEXT_SUMMARY_MODEL || (summaryConnection?.models.includes(modelSettings.model) ? modelSettings.model : modelDeployment.model);
  const summarize = parseBooleanConfig(undefined, environment.ENABLE_CONTEXT_SUMMARY, Boolean(modelDeployment.apiKey))
    ? createContextModelSummarizer({ apiKey: modelDeployment.apiKey, baseUrl: modelDeployment.baseUrl, model: summaryModel, timeoutMs: summaryConnection?.timeoutMs ?? modelDeployment.timeoutMs })
    : undefined;
  const conversations = createConversations({ database, tenantId: tenant.id, history: agentHistory, delivery: sessionDelivery, execution: codexExecution, environment,
    summarize, vectorSearch,
    contextRoot: path.join(rootDir, '.workflow-data', 'context', createHash('sha256').update(tenant.id).digest('hex')) });
  const deviceServices: DeviceServices = { execution: codexExecution, git: remoteGit, conversations, taskCenter };
  const groupChats = createGroupChats({ database, tenantId: tenant.id, execution: codexExecution });
  const collaborations = createCollaborations({ database, tenantId: tenant.id, execution: codexExecution });
  let groupChatPending: Promise<void> | undefined;
  const groupChatTimer = setInterval(() => {
    if (mutationPending) return;
    mutationPending = true;
    groupChatPending = groupChats.progress().catch(error => console.error('群聊推进失败', sanitizeError(error))).finally(() => { mutationPending = false; });
  }, 1500);
  groupChatTimer.unref();
  const conversationTimer = setInterval(() => { void conversations.preparePending().catch(() => {}); }, 1500);
  conversationTimer.unref();
  return {
    deviceServices,
    workspace: () => state.config.codexWorkspaceDir,
    subscribeRealtime(input: RealtimeSubscription, userId: string, send: (event: RealtimeEvent) => void, onError: (error: unknown) => void, boundDevice?: string) {
      if (input.channel === 'task-center') return taskCenterStream.subscribe(input.since, update => send({ type: 'task-center', ...update }));
      return deviceControl.subscribe(new URLSearchParams({ deviceId: input.deviceId }), userId, version => send({ type: 'device-control', version }), onError, boundDevice);
    },
    async reportRealtime(deviceId: string, input: ExecutionFeedback, principal: Principal) {
      let status = 200;
      const target = workFor('report', input.executionId, principal.user, deviceId, principal.connectorDeviceId);
      try {
        const job = database.readTaskCenter(target.tenantId).executions?.find(item => item.id === input.executionId);
        if (!job || job.deviceId !== deviceId) throw httpError(403, '执行不属于此设备');
        await target.services.execution.action({ ...input, action: 'report', report: input.report as Parameters<typeof codexExecution.action>[0]['report'] }, target.actor);
      } catch (error) {
        status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
        throw error;
      } finally {
        database.audit(target.tenantId, target.actor, 'api.request', '/api/task-center/execution-action', { method: 'WEBSOCKET', status });
      }
    },
    closeStreams: () => { taskCenterStream.close(); deviceControl.close(); modelConnectionProbe?.abort(); },
    async handleApi(req: IncomingMessage, res: ServerResponse, url: URL, principal: Principal) {
      const { pathname } = url;
      const independent = req.method === 'POST' && (independentWrites.has(pathname) || newConversationPath.test(pathname) ||
        continuationPath.test(pathname) || contextTransferPath.test(pathname) || contextTransferObjectPath.test(pathname));
      const mutation = req.method !== 'GET' && !independent;
      if (mutation && mutationPending) { sendJson(res, 409, { error: 'tenant_busy', message: '当前账号正在处理其他请求，请稍后重试' }); req.resume(); return; }
      if (mutation) mutationPending = true;
      try { await requestIdentity.run(principal, () => handleApi(req, res, url)); }
      catch (caught: unknown) { const error = asError(caught); error.message = sanitizeError(error); throw error; }
      finally { if (mutation) mutationPending = false; }
    },
    async close() {
      clearInterval(groupChatTimer); groupChats.close();
      await groupChatPending;
      taskCenterStream.close();
      deviceControl.close();
      await vectorSearch.close();
      clearInterval(conversationTimer); conversations.close(); codexExecution.close(); configureScheduler(false); assignmentJobSeq++; await persistIssueState(); closing = true;
    }
  };
}
