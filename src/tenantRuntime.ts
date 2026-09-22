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

export function createTenantRuntime({ database, tenant, environment, rootDir, validateWorkspace = () => {} }: any) {
  const requestIdentity = new AsyncLocalStorage<any>();
  const mode = issueSourceId(environment);
  const storedSettings = database.readSettings(tenant.id);
  const persistedConfig = storedSettings.config;
  const state: any = {
    config: {
      mode,
      assignee: persistedConfig.assignee ?? '',
      operatorId: persistedConfig.operatorId ?? '',
      selfOnly: persistedConfig.selfOnly ?? false,
      ...issueSourceConfig({ environment, config: persistedConfig }),
      intervalMinutes: clampNumber(persistedConfig.intervalMinutes ?? environment.POLL_INTERVAL_MINUTES, 1, 240, 30),
      codexWorkspaceDir: environment.CODEX_WORKSPACE_DIR ? resolveWorkspaceDir(environment.CODEX_WORKSPACE_DIR) : (tenant.id === 'default' ? resolveWorkspaceDir(persistedConfig.codexWorkspaceDir || rootDir) : ''),
      enableAIAssignment: parseBooleanConfig(persistedConfig.enableAIAssignment, environment.ENABLE_AI_ASSIGNMENT, true),
      enableAutoAssignment: parseBooleanConfig(persistedConfig.enableAutoAssignment, environment.ENABLE_AUTO_ASSIGNMENT, false),
      aiAssignmentModel: String(persistedConfig.aiAssignmentModel ?? environment.AI_ASSIGNMENT_MODEL ?? 'gpt-5.4-mini'),
      openaiBaseUrl: normalizeUrl(persistedConfig.openaiBaseUrl ?? persistedConfig.aiRoutingBaseUrl ?? environment.OPENAI_BASE_URL ?? 'https://api.openai.com/v1', 'https://api.openai.com/v1'),
      openaiTimeoutMs: clampNumber(persistedConfig.openaiTimeoutMs ?? persistedConfig.aiRoutingTimeoutMs ?? environment.OPENAI_TIMEOUT_MS ?? environment.AI_ROUTING_TIMEOUT_MS, 5000, 120000, 30000)
    },
    assignmentPeople: normalizeAssignmentPeople(storedSettings.assignmentPeople, { fallback: [] }),
    scheduler: { enabled: false, lastSyncTime: null, nextRunAt: null, lastRunStatus: 'idle', lastRunMessage: '尚未执行同步' },
    bugs: [],
    storageUserKey: ''
  };
  const issueStore = database.createStore(tenant.id);
  let schedulerTimer: any = null, assignmentJobSeq = 0, assignmentBatchPromise: any = null, assignmentJobsPending = 0, mutationPending = false, closing = false;
  const activeAssignmentBugIds = new Set();

  function loadIssueState(userKey: any) {
    const stored = issueStore.readUserState(userKey);
    state.storageUserKey = stored.userKey;
    state.bugs = stored.bugs;
  }
  loadIssueState(sourceStorageKey(issueSource(), resolveUserStorageKey(state.config)));

  async function persistIssueState(_options: any = {}) {
    if (closing) return;
    await issueStore.writeUserState(state.storageUserKey, { bugs: state.bugs, updatedAt: new Date().toISOString() });
  }
  async function switchIssueUserContext(nextConfig: any) {
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

  async function handleApi(req: any, res: any, url: any) {
    const newConversation = /^\/api\/sessions\/([a-f0-9]{64})\/continue-as-new$/.exec(url.pathname);
    if (newConversation && req.method === 'POST') { sendJson(res, 202, await conversations.create(newConversation[1], await readJson(req))); return; }
    if (url.pathname === '/api/conversations' && req.method === 'GET') { sendJson(res, 200, { sessions: conversations.list() }); return; }
    const inherited = /^\/api\/conversations\/([a-f0-9]{64})\/inherited$/.exec(url.pathname);
    if (inherited && req.method === 'GET') { sendJson(res, 200, conversations.inherited(inherited[1], url.searchParams)); return; }
    if (url.pathname === '/api/task-center/git' && req.method === 'POST') { sendJson(res, 200, await codexExecution.git(await readJson(req))); return; }
    if (url.pathname === '/api/task-center/directory-picker') {
      const actor = requestIdentity.getStore().user;
      sendJson(res, 200, req.method === 'GET' ? codexExecution.directoryStatus({ requestId: url.searchParams.get('requestId') }, actor) : await codexExecution.pickDirectory(await readJson(req), actor)); return;
    }
    if (url.pathname === '/api/task-center/directory-action') { sendJson(res, 200, codexExecution.directoryAction(await readJson(req), requestIdentity.getStore().user)); return; }
    if (url.pathname === '/api/task-center/codex') { sendJson(res, 200, await codexExecution.targets()); return; }
    if (url.pathname === '/api/task-center/execute') { sendJson(res, 202, await codexExecution.execute(await readJson(req, 15_000_000))); return; }
    if (url.pathname === '/api/task-center/execution-action') { sendJson(res, 200, await codexExecution.action(await readJson(req, 8_000_000), requestIdentity.getStore().user)); return; }
    if (url.pathname === '/api/task-center') {
      sendJson(res, 200, req.method === 'GET' ? await taskCenter.snapshot() : await taskCenter.command(await readJson(req), requestIdentity.getStore().user)); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') { sendJson(res, 200, await sessionDelivery.list(url.searchParams)); return; }
    const delivery = /^\/api\/sessions\/([a-f0-9]{64})(?:\/(events|records))?$/.exec(url.pathname);
    if (req.method === 'GET' && delivery) { const operation = delivery[2] === 'records' ? 'record' : delivery[2] || 'detail'; sendJson(res, 200, await sessionDelivery[operation](delivery[1], url.searchParams)); return; }
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
      const existing = (await taskCenter.snapshot()).tasks.find((task: any) => task.source?.type === 'defect' && task.source.id === bug.id);
      if (existing) return sendJson(res, 200, { taskId: existing.id, revision: existing.revision, existing: true });
      await ensureBugAttachmentsLoaded(bug);
      const result = await taskCenter.command({ action: 'create', title: `[${bug.code || bug.id}] ${bug.title}`.slice(0, 120), source: { type: 'defect', id: bug.id, code: bug.code || '' }, content: taskContent({ context: defectTaskContext(bug) }) }, requestIdentity.getStore().user);
      sendJson(res, 201, { ...result, existing: false }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/assignments/apply-all') {
      const result = await applyReadyAssignments({ source: 'manual-batch' }); sendJson(res, 200, { result, ...getBootstrap() }); return;
    }
    const apply = url.pathname.match(/^\/api\/bugs\/([^/]+)\/assignment\/apply$/);
    if (req.method === 'POST' && apply) {
      const bug = findBug(decodeURIComponent(apply[1])); if (!bug) return sendJson(res, 404, { error: 'bug_not_found', message: '缺陷不存在' });
      try { const result = await applyBugAssignment(bug, await readJson(req)); await persistIssueState(); sendJson(res, 200, { bug, result }); }
      catch (error: any) { bug.assignmentRecommendation = { ...(bug.assignmentRecommendation || {}), status: 'assign-failed', assigned: false, error: sanitizeError(error), failedAt: new Date().toISOString() }; await persistIssueState(); sendJson(res, 400, { error: 'assignment_failed', message: sanitizeError(error), bug }); }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/scheduler') {
      state.scheduler.enabled = Boolean((await readJson(req)).enabled); configureScheduler(state.scheduler.enabled); sendJson(res, 200, getBootstrap()); return;
    }
    sendJson(res, 404, { error: 'not_found', message: '接口不存在' });
  }

  function findBug(id: string) { return state.bugs.find((item: any) => item.id === id || item.aid === id); }
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
    const metrics: any = { total: state.bugs.length, pending: 0, processing: 0, resolved: 0, other: 0, byStatus: {} };
    for (const bug of state.bugs) { const key = statusGroupOf(bug.status); metrics[key]++; const status = bug.status || '未知'; metrics.byStatus[status] = (metrics.byStatus[status] || 0) + 1; }
    return metrics;
  }
  function statusGroupOf(status: any) {
    const value = String(status || '').toLowerCase();
    if (/待处理|未处理|待受理|待确认|待分配|open|new|todo|pending|onaudit/.test(value)) return 'pending';
    if (/处理中|处理|进行中|修复中|in progress|doing|processing|develop|fix/.test(value)) return 'processing';
    if (/已解决|已关闭|已完成|关闭|解决|完成|resolved|closed|done|finish/.test(value)) return 'resolved';
    return 'other';
  }
  function isAssignableBugStatus(status: any) { return ['pending', 'processing'].includes(statusGroupOf(status)); }
  function defectTaskContext(bug: any) {
    const steps = Array.isArray(bug.reproduceSteps) ? bug.reproduceSteps : [];
    const facts = [`缺陷编码：${bug.code || bug.id}`, `标题：${bug.title || '未填写'}`, `状态：${bug.status || '未知'}`, `优先级：${bug.priority || bug.severity || '未填写'}`, bug.description ? `描述：${bug.description}` : '', steps.length ? `复现步骤：\n${steps.map((step: any, index: number) => `${index + 1}. ${typeof step === 'string' ? step : JSON.stringify(step)}`).join('\n')}` : '', bug.expected ? `预期结果：${bug.expected}` : '', bug.actual ? `实际结果：${bug.actual}` : ''].filter(Boolean);
    return { goal: `修复缺陷 ${bug.code || bug.id}：${bug.title || ''}`, constraints: facts.join('\n\n'), decisions: '此任务直接来源于缺陷工作台，缺陷原始信息作为任务上下文。', next: '分析并复现缺陷，完成修复与必要测试，汇报验证结果。', files: (bug.attachments || []).map((item: any) => `- ${item.name || '附件'}：${item.url || '无链接'}`).join('\n') };
  }
  function extractResponseText(payload: any) {
    if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
    const chunks: string[] = []; for (const item of payload?.output || []) for (const part of item?.content || []) if (typeof part?.text === 'string') chunks.push(part.text);
    const text = chunks.join('\n').trim(); if (!text) throw new Error('模型响应为空。'); return text;
  }
function startAssignmentRecommendationsForBugs(bugs: any) {
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

async function runAssignmentRecommendationJob(jobId: any) {
  for (const bug of state.bugs) {
    if (jobId !== assignmentJobSeq) return;
    if (bug.assignmentRecommendation?.status !== "pending") continue;
    bug.assignmentRecommendation = await recommendBugAssignee(bug);
  }

  if (jobId !== assignmentJobSeq) return;
  const assignmentReady = state.bugs.filter((bug: any) => bug.assignmentRecommendation?.status === "ready").length;
  const assignmentFailed = state.bugs.filter((bug: any) => bug.assignmentRecommendation?.status === "error").length;
  if (state.config.enableAutoAssignment && assignmentReady > 0) {
    const batch = await applyReadyAssignments({ source: "auto" });
    state.scheduler.lastRunMessage = `AI 分配建议已完成；自动分配成功 ${batch.success} 条${batch.failed ? `，失败 ${batch.failed} 条` : ""}`;
  } else {
    state.scheduler.lastRunMessage = `AI 分配建议已完成：成功 ${assignmentReady} 条${assignmentFailed ? `，失败 ${assignmentFailed} 条` : ""}`;
  }
  await persistIssueState({ immediate: true });
}

async function recommendBugAssignee(bug: any) {
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
      throw new Error(`模型分配请求失败 HTTP ${response.status}: ${payload?.error?.message || JSON.stringify(payload)}`);
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
  } catch (error: any) {
    const message = error?.name === "AbortError" ? `模型分配超时：${state.config.openaiTimeoutMs}ms` : sanitizeError(error);
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

async function postAssignmentModelRequest({ baseUrl, model, bug, signal }: any) {
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
  const payload: any = await response.json().catch(() => ({}));
  return { response, payload };
}

async function applyBugAssignment(bug: any, body: any = {}) {
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

async function applyBugAssignmentUnlocked(bug: any, body: any = {}) {
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

async function applyReadyAssignments({ source = "manual-batch" }: any = {}) {
  if (assignmentBatchPromise) return assignmentBatchPromise;

  assignmentBatchPromise = runReadyAssignmentBatch({ source });
  try {
    return await assignmentBatchPromise;
  } finally {
    assignmentBatchPromise = null;
  }
}

async function runReadyAssignmentBatch({ source }: any) {
  const candidates = state.bugs.filter((bug: any) => isAssignmentCandidate(bug, isAssignableBugStatus));
  const results: any[] = [];

  for (const [index, bug] of candidates.entries()) {
    const recommendation = bug.assignmentRecommendation;
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
    } catch (error: any) {
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
  const summary: any = {
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

async function ensureBugAttachmentsLoaded(bug: any) {
  if (bug.attachmentsLoaded) return;

  try {
    const attachments = await issueSource().attachments(bug);

    bug.attachments = attachments;
    bug.attachmentsLoaded = true;
    bug.attachmentsError = "";
  } catch (error: any) {
    bug.attachments = bug.attachments || [];
    bug.attachmentsLoaded = false;
    bug.attachmentsError = sanitizeError(error);
  }
}


  function resolveUserStorageKey(config: any = {}) {
    const value = String(config.assignee || (config.selfOnly && config.operatorId) || config.operatorId || 'default').trim().toLowerCase();
    return value.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'default';
  }
  function updateConfig(body: any) {
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
  function hasOwn(object: any, key: any) { return Object.prototype.hasOwnProperty.call(object, key); }
  function stringConfig(object: any, key: any, fallback: any) { return hasOwn(object, key) ? String(object[key] ?? '').trim() : fallback; }
  function booleanConfig(object: any, key: any, fallback: any) { return typeof object[key] === 'boolean' ? object[key] : fallback; }
  function numberConfig(object: any, key: any, min: any, max: any, fallback: any) { return hasOwn(object, key) ? clampNumber(object[key], min, max, fallback) : fallback; }
  async function syncBugs({ incremental = false }: any = {}) {
    state.scheduler.lastRunStatus = 'running'; state.scheduler.lastRunMessage = '正在同步缺陷';
    try {
      const source = issueSource(), startedAt = new Date(), bugs = await source.sync({ lastSyncTime: incremental ? state.scheduler.lastSyncTime : null });
      state.bugs = incremental ? mergeBugs(state.bugs, bugs) : bugs;
      startAssignmentRecommendationsForBugs(state.bugs);
      state.scheduler.lastRunMessage = `${source.label} 同步完成，获取 ${bugs.length} 条缺陷；AI 分配建议后台生成中`;
      state.scheduler.lastRunStatus = 'success'; state.scheduler.lastSyncTime = syncCheckpoint(source, startedAt); state.scheduler.nextRunAt = nextRunIso();
      await persistIssueState(); return { ok: true, ...getBootstrap() };
    } catch (error: any) {
      state.scheduler.lastRunStatus = 'error'; state.scheduler.lastRunMessage = sanitizeError(error); state.scheduler.nextRunAt = nextRunIso();
      return { ok: false, message: state.scheduler.lastRunMessage, ...getBootstrap() };
    }
  }
  function issueSource() { return createIssueSource({ config: state.config, environment }); }
  function configureScheduler(enabled: any) {
    if (schedulerTimer) clearInterval(schedulerTimer); schedulerTimer = null;
    if (!enabled) { state.scheduler.nextRunAt = null; return; }
    state.scheduler.nextRunAt = nextRunIso();
    schedulerTimer = setInterval(() => {
      if (mutationPending || hasBackgroundWork()) return;
      mutationPending = true; syncBugs({ incremental: true }).catch((error) => { state.scheduler.lastRunStatus = 'error'; state.scheduler.lastRunMessage = sanitizeError(error); }).finally(() => { mutationPending = false; });
    }, state.config.intervalMinutes * 60 * 1000);
  }
  function mergeBugs(current: any, updates: any) {
    const byId = new Map<any, any>(current.map((bug: any) => [bug.id, bug])); for (const bug of updates) byId.set(bug.id, { ...byId.get(bug.id), ...bug });
    return [...byId.values()].sort((a: any, b: any) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  }
  function readJson(req: any, limit = 1_000_000): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = '', size = 0; req.on('data', (chunk: any) => { size += chunk.length; if (size > limit) { reject(Object.assign(new Error('请求体过大'), { statusCode: 413 })); return; } data += chunk; });
      req.on('end', () => { if (!data) return resolve({}); try { const parsed = JSON.parse(data); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象'); resolve(parsed); } catch (error: any) { reject(Object.assign(error, { statusCode: 400 })); } }); req.on('error', reject);
    });
  }
  function sendJson(res: any, status: any, data: any) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
  function clampNumber(value: any, min: any, max: any, fallback: any) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; }
  function parseBooleanConfig(persisted: any, env: any, fallback: any) { if (typeof persisted === 'boolean') return persisted; return typeof env === 'string' ? /^(true|1|yes|on)$/i.test(env.trim()) : fallback; }
  function resolveWorkspaceDir(value: any) { const raw = String(value || '').trim(); return raw ? path.resolve(rootDir, raw) : rootDir; }
  function normalizeUrl(value: any, fallback: any) { try { return new URL(String(value || fallback)).toString().replace(/\/+$/, ''); } catch { return fallback; } }
  function nextRunIso() { return new Date(Date.now() + state.config.intervalMinutes * 60 * 1000).toISOString(); }
  function sleep(ms: any) { return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0))); }
  function sanitizeError(error: any) {
    let message = String(error?.message || error); for (const key of Object.keys(environment).filter((key) => /KEY|SECRET|TOKEN|COOKIE/.test(key))) if (environment[key]) message = message.split(environment[key]).join('[redacted]');
    return message;
  }
  function hasBackgroundWork() { return assignmentJobsPending > 0 || Boolean(assignmentBatchPromise) || activeAssignmentBugIds.size > 0; }

  const agentHistory = createAgentHistory({ environment, tenantId: tenant.id, rootDir, workspace: () => state.config.codexWorkspaceDir });
  const sessionDelivery: any = createSessionDelivery({ history: agentHistory, environment });
  const taskCenter = createTaskCenter({ database, tenantId: tenant.id, history: agentHistory });
  const codexExecution = createCodexExecution({ database, attachmentRoot: path.join(rootDir, '.workflow-data', 'attachments', createHash('sha256').update(tenant.id).digest('hex')), tenantId: tenant.id, workspace: () => state.config.codexWorkspaceDir, history: agentHistory, environment });
  const conversations = createConversations({ database, tenantId: tenant.id, history: agentHistory, delivery: sessionDelivery, execution: codexExecution, environment,
    contextRoot: path.join(rootDir, '.workflow-data', 'context', createHash('sha256').update(tenant.id).digest('hex')) });
  const conversationTimer = setInterval(() => { void conversations.preparePending().catch(() => {}); }, 1500);
  conversationTimer.unref();
  return {
    workspace: () => state.config.codexWorkspaceDir,
    async handleApi(req: any, res: any, url: any, principal: any) {
      const historyRead = req.method === 'GET' && (url.pathname.startsWith('/api/agent-sessions') || url.pathname.startsWith('/api/sessions'));
      const mutation = !historyRead && (req.method !== 'GET' || url.pathname !== '/api/bootstrap');
      if (mutation && mutationPending) { sendJson(res, 409, { error: 'tenant_busy', message: '当前组织正在处理其他请求，请稍后重试' }); req.resume(); return; }
      if (mutation) mutationPending = true;
      try { await requestIdentity.run(principal, () => handleApi(req, res, url)); }
      catch (error: any) { error.message = sanitizeError(error); throw error; }
      finally { if (mutation) mutationPending = false; }
    },
    async close() {
      clearInterval(conversationTimer); conversations.close(); codexExecution.close(); configureScheduler(false); assignmentJobSeq++; await persistIssueState(); closing = true;
    }
  };
}
