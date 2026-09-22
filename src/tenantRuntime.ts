import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { taskContent } from '../public/taskContent.js';
import { createHash } from 'node:crypto';
import { publicIdentity } from './rbac.js';
import { createSessionDelivery } from './sessionDelivery/index.ts';
import { createAgentHistory } from './agentHistory/index.js';
import { createTaskCenter } from './taskCenter.js';
import { createCodexExecution } from './codexExecution.js';
import { createConversations } from './conversations.js';
import { applyAssignmentBusinessRules, buildAssignmentJsonSchema, buildAssignmentSystemPrompt, buildAssignmentUserPayload, isAssignmentCandidate, normalizeAssignmentPeople, normalizeAssignmentRecommendation } from './assignmentEngine.js';
import { createIssueSource, issueSourceConfig, issueSourceId, sourceStorageKey, syncCheckpoint } from './issueSources/index.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Tenant } from './database.js';
import type { Environment, IssueAttachment, WorkIssue } from './issueSources/types.js';

type Database = ReturnType<typeof import('./database.js').openDatabase>;
type JsonObject = Record<string, unknown>;
interface Principal { user: { id: string; role: string; [key: string]: unknown }; tenant: Tenant; expiresAt?: string }
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
  aiAssignmentModel: string; openaiBaseUrl: string; openaiTimeoutMs: number; requestDelayMs: number;
}
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
interface ModelPayload { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }>; error?: { message?: string } }

const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

export function createTenantRuntime({ database, tenant, environment, rootDir, validateWorkspace = () => {} }: {
  database: Database; tenant: Tenant; environment: Environment; rootDir: string; validateWorkspace?: (workspace: unknown) => void;
}) {
  const requestIdentity = new AsyncLocalStorage<Principal>();
  const mode = issueSourceId(environment);
  const storedSettings = database.readSettings(tenant.id);
  const persistedConfig = storedSettings.config;
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
      aiAssignmentModel: String(persistedConfig.aiAssignmentModel ?? environment.AI_ASSIGNMENT_MODEL ?? 'gpt-5.4-mini'),
      openaiBaseUrl: normalizeUrl(persistedConfig.openaiBaseUrl ?? persistedConfig.aiRoutingBaseUrl ?? environment.OPENAI_BASE_URL ?? 'https://api.openai.com/v1', 'https://api.openai.com/v1'),
      openaiTimeoutMs: clampNumber(persistedConfig.openaiTimeoutMs ?? persistedConfig.aiRoutingTimeoutMs ?? environment.OPENAI_TIMEOUT_MS ?? environment.AI_ROUTING_TIMEOUT_MS, 5000, 120000, 30000),
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
  async function switchIssueUserContext(nextConfig: RuntimeConfig) {
    const nextKey = sourceStorageKey(issueSource(), resolveUserStorageKey(nextConfig));
    if (nextKey === state.storageUserKey) return;
    await persistIssueState();
    loadIssueState(nextKey);
    state.scheduler.lastSyncTime = null;
    state.scheduler.lastRunStatus = 'idle';
    state.scheduler.lastRunMessage = '已切换经办人，等待同步';
  }
  async function persistConfig() {
    database.writeSettings(tenant.id, { config: {
      ...issueSourceConfig({ environment, config: state.config }),
      assignee: state.config.assignee, operatorId: state.config.operatorId, selfOnly: Boolean(state.config.selfOnly),
      intervalMinutes: state.config.intervalMinutes, codexWorkspaceDir: state.config.codexWorkspaceDir,
      enableAIAssignment: Boolean(state.config.enableAIAssignment), enableAutoAssignment: Boolean(state.config.enableAutoAssignment),
      aiAssignmentModel: state.config.aiAssignmentModel, openaiBaseUrl: state.config.openaiBaseUrl,
      openaiTimeoutMs: state.config.openaiTimeoutMs
    }});
  }
  async function persistAssignmentPeople() {
    database.writeSettings(tenant.id, { assignmentPeople: normalizeAssignmentPeople(state.assignmentPeople, { fallback: [] }) });
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const newConversation = /^\/api\/sessions\/([a-f0-9]{64})\/continue-as-new$/.exec(url.pathname);
    if (newConversation && req.method === 'POST') { sendJson(res, 202, await conversations.create(newConversation[1], await readJson(req))); return; }
    if (url.pathname === '/api/conversations' && req.method === 'GET') { sendJson(res, 200, { sessions: conversations.list() }); return; }
    const inherited = /^\/api\/conversations\/([a-f0-9]{64})\/inherited$/.exec(url.pathname);
    if (inherited && req.method === 'GET') { sendJson(res, 200, conversations.inherited(inherited[1], url.searchParams)); return; }
    if (url.pathname === '/api/task-center/git' && req.method === 'POST') { sendJson(res, 200, await codexExecution.git(await readJson(req))); return; }
    if (url.pathname === '/api/task-center/directory-picker') {
      const actor = requestIdentity.getStore()!.user;
      sendJson(res, 200, req.method === 'GET' ? codexExecution.directoryStatus({ requestId: url.searchParams.get('requestId') || undefined }, actor) : await codexExecution.pickDirectory(await readJson(req), actor)); return;
    }
    if (url.pathname === '/api/task-center/directory-action') { sendJson(res, 200, codexExecution.directoryAction(await readJson(req), requestIdentity.getStore()!.user)); return; }
    if (url.pathname === '/api/task-center/codex') { sendJson(res, 200, await codexExecution.targets()); return; }
    if (url.pathname === '/api/task-center/execute') { sendJson(res, 202, await codexExecution.execute(await readJson(req, 15_000_000))); return; }
    if (url.pathname === '/api/task-center/execution-action') { sendJson(res, 200, await codexExecution.action(await readJson(req, 8_000_000), requestIdentity.getStore()!.user)); return; }
    if (url.pathname === '/api/task-center') {
      sendJson(res, 200, req.method === 'GET' ? await taskCenter.snapshot() : await taskCenter.command(await readJson(req), requestIdentity.getStore()!.user)); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') { sendJson(res, 200, await sessionDelivery.list(url.searchParams)); return; }
    const delivery = /^\/api\/sessions\/([a-f0-9]{64})(?:\/(events|records))?$/.exec(url.pathname);
    if (req.method === 'GET' && delivery) {
      const result = delivery[2] === 'records' ? await sessionDelivery.record(delivery[1], url.searchParams) : delivery[2] === 'events' ? await sessionDelivery.events(delivery[1], url.searchParams) : await sessionDelivery.detail(delivery[1], url.searchParams);
      sendJson(res, 200, result); return;
    }
    const continuation = /^\/api\/agent-sessions\/([a-f0-9]{64})\/continue$/.exec(url.pathname);
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
      if (hasBackgroundWork()) { sendJson(res, 409, { error: 'tenant_busy', message: '当前组织有后台任务执行中，请稍后修改配置' }); return; }
      const body = await readJson(req);
      validateWorkspace(body.codexWorkspaceDir ?? state.config.codexWorkspaceDir);
      updateConfig(body); await switchIssueUserContext(state.config); await persistConfig(); configureScheduler(state.scheduler.enabled);
      sendJson(res, 200, getBootstrap()); return;
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
    return {
      ...(requestIdentity.getStore() ? publicIdentity(requestIdentity.getStore()) : {}),
      tenant: { id: tenant.id, name: tenant.name }, storage: { driver: 'sqlite', schemaVersion: 4 },
      config: { ...state.config, workspaceManaged: Boolean(environment.CODEX_WORKSPACE_DIR) || database.listTenants().length > 1, issueSourceLabel: issueSource().label, issueSourceConfigured: issueSource().configured },
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
  function extractResponseText(payload: ModelPayload) {
    if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
    const chunks: string[] = []; for (const item of payload?.output || []) for (const part of item?.content || []) if (typeof part?.text === 'string') chunks.push(part.text);
    const text = chunks.join('\n').trim(); if (!text) throw new Error('模型响应为空。'); return text;
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

  if (!environment.OPENAI_API_KEY) {
    return {
      status: "error",
      source: "model",
      error: "未配置 OPENAI_API_KEY，无法生成 AI 分配建议。",
      createdAt: new Date().toISOString()
    };
  }

  const model = String(state.config.aiAssignmentModel || 'gpt-5.4-mini');
  const baseUrl = normalizeUrl(state.config.openaiBaseUrl, "https://api.openai.com/v1").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), state.config.openaiTimeoutMs).unref();
  const startedAt = Date.now();
  console.info(`[ai-assignment] request ${JSON.stringify({
    bugCode: bug.code || bug.id || "unknown",
    model,
    baseUrl,
    peopleCount: state.assignmentPeople.length,
    title: bug.title || ""
  })}`);

  try {
    const { payload, response } = await postAssignmentModelRequest({
      baseUrl,
      model,
      bug,
      signal: controller.signal
    });

    console.info(`[ai-assignment] response bug=${bug.code || bug.id || "unknown"} status=${response.status} elapsedMs=${Date.now() - startedAt}`);

    if (!response.ok) {
      throw new Error(`模型分配请求失败 HTTP ${response.status}: ${payload.error?.message || JSON.stringify(payload)}`);
    }

    const recommendation = applyAssignmentBusinessRules(
      bug,
      normalizeAssignmentRecommendation(JSON.parse(extractResponseText(payload)), { model, people: state.assignmentPeople }),
      state.assignmentPeople
    );
    console.info(`[ai-assignment] result bug=${bug.code || bug.id || "unknown"} ${JSON.stringify({
      assigneeId: recommendation.assigneeId,
      assigneeName: recommendation.assigneeName,
      confidence: recommendation.confidence,
      reason: recommendation.reason
    })}`);
    return recommendation;
  } catch (error: unknown) {
    const message = asError(error).name === "AbortError" ? `模型分配超时：${state.config.openaiTimeoutMs}ms` : sanitizeError(error);
    console.warn(`[ai-assignment] error bug=${bug.code || bug.id || "unknown"} ${message}`);
    return {
      status: "error",
      source: "model",
      model,
      error: message,
      createdAt: new Date().toISOString()
    };
  } finally {
    clearTimeout(timer);
  }
}

async function postAssignmentModelRequest({ baseUrl, model, bug, signal }: { baseUrl: string; model: string; bug: RuntimeIssue; signal: AbortSignal }) {
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${environment.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: buildAssignmentSystemPrompt(state.assignmentPeople)
        },
        {
          role: "user",
          content: JSON.stringify(buildAssignmentUserPayload(bug, state.assignmentPeople))
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "bug_assignment",
          strict: true,
          schema: buildAssignmentJsonSchema(state.assignmentPeople)
        }
      }
    })
  });
  const payload = await response.json().catch(() => ({})) as ModelPayload;
  return { response, payload };
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
  function updateConfig(body: JsonObject) {
    const next = body || {};
    state.config = {
      ...state.config, mode, ...issueSourceConfig({ environment, config: state.config }, next),
      assignee: stringConfig(next, 'assignee', state.config.assignee), operatorId: stringConfig(next, 'operatorId', state.config.operatorId),
      selfOnly: booleanConfig(next, 'selfOnly', state.config.selfOnly), intervalMinutes: numberConfig(next, 'intervalMinutes', 1, 240, state.config.intervalMinutes),
      codexWorkspaceDir: stringConfig(next, 'codexWorkspaceDir', state.config.codexWorkspaceDir) ? resolveWorkspaceDir(stringConfig(next, 'codexWorkspaceDir', state.config.codexWorkspaceDir)) : '',
      enableAIAssignment: booleanConfig(next, 'enableAIAssignment', state.config.enableAIAssignment),
      enableAutoAssignment: booleanConfig(next, 'enableAutoAssignment', state.config.enableAutoAssignment),
      aiAssignmentModel: stringConfig(next, 'aiAssignmentModel', state.config.aiAssignmentModel),
      openaiBaseUrl: normalizeUrl(stringConfig(next, 'openaiBaseUrl', state.config.openaiBaseUrl), 'https://api.openai.com/v1'),
      openaiTimeoutMs: numberConfig(next, 'openaiTimeoutMs', 5000, 120000, state.config.openaiTimeoutMs)
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
  function issueSource() { return createIssueSource({ config: state.config, environment }); }
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
  function readJson(req: IncomingMessage, limit = 1_000_000): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
      let data = '', size = 0; req.on('data', (chunk: Buffer | string) => { size += Buffer.byteLength(chunk); if (size > limit) { reject(Object.assign(new Error('请求体过大'), { statusCode: 413 })); return; } data += chunk; });
      req.on('end', () => { if (!data) return resolve({}); try { const parsed: unknown = JSON.parse(data); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象'); resolve(parsed as JsonObject); } catch (error: unknown) { reject(Object.assign(asError(error), { statusCode: 400 })); } }); req.on('error', reject);
    });
  }
  function sendJson(res: ServerResponse, status: number, data: unknown) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
  function clampNumber(value: unknown, min: number, max: number, fallback: number) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; }
  function parseBooleanConfig(persisted: unknown, env: unknown, fallback: boolean) { if (typeof persisted === 'boolean') return persisted; return typeof env === 'string' ? /^(true|1|yes|on)$/i.test(env.trim()) : fallback; }
  function resolveWorkspaceDir(value: unknown) { const raw = String(value || '').trim(); return raw ? path.resolve(rootDir, raw) : rootDir; }
  function normalizeUrl(value: unknown, fallback: string) { try { return new URL(String(value || fallback)).toString().replace(/\/+$/, ''); } catch { return fallback; } }
  function nextRunIso() { return new Date(Date.now() + state.config.intervalMinutes * 60 * 1000).toISOString(); }
  function sleep(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))); }
  function sanitizeError(error: unknown) {
    let message = asError(error).message; for (const key of Object.keys(environment).filter((key) => /KEY|SECRET|TOKEN|COOKIE/.test(key))) if (environment[key]) message = message.split(environment[key]!).join('[redacted]');
    return message;
  }
  function hasBackgroundWork() { return assignmentJobsPending > 0 || Boolean(assignmentBatchPromise) || activeAssignmentBugIds.size > 0; }

  const agentHistory = createAgentHistory({ environment, tenantId: tenant.id, rootDir, workspace: () => state.config.codexWorkspaceDir });
  const sessionDelivery = createSessionDelivery({ history: agentHistory, environment });
  const taskCenter = createTaskCenter({ database, tenantId: tenant.id, history: agentHistory });
  const codexExecution = createCodexExecution({ database, attachmentRoot: path.join(rootDir, '.workflow-data', 'attachments', createHash('sha256').update(tenant.id).digest('hex')), tenantId: tenant.id, workspace: () => state.config.codexWorkspaceDir, history: agentHistory, environment });
  const conversations = createConversations({ database, tenantId: tenant.id, history: agentHistory, delivery: sessionDelivery, execution: codexExecution, environment,
    contextRoot: path.join(rootDir, '.workflow-data', 'context', createHash('sha256').update(tenant.id).digest('hex')) });
  const conversationTimer = setInterval(() => { void conversations.preparePending().catch(() => {}); }, 1500);
  conversationTimer.unref();
  return {
    workspace: () => state.config.codexWorkspaceDir,
    async handleApi(req: IncomingMessage, res: ServerResponse, url: URL, principal: Principal) {
      const historyRead = req.method === 'GET' && (url.pathname.startsWith('/api/agent-sessions') || url.pathname.startsWith('/api/sessions'));
      const mutation = !historyRead && (req.method !== 'GET' || url.pathname !== '/api/bootstrap');
      if (mutation && mutationPending) { sendJson(res, 409, { error: 'tenant_busy', message: '当前组织正在处理其他请求，请稍后重试' }); req.resume(); return; }
      if (mutation) mutationPending = true;
      try { await requestIdentity.run(principal, () => handleApi(req, res, url)); }
      catch (caught: unknown) { const error = asError(caught); error.message = sanitizeError(error); throw error; }
      finally { if (mutation) mutationPending = false; }
    },
    async close() {
      clearInterval(conversationTimer); conversations.close(); codexExecution.close(); configureScheduler(false); assignmentJobSeq++; await persistIssueState(); closing = true;
    }
  };
}
