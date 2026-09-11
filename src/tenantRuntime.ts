// @ts-nocheck
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { publicIdentity } from "./rbac.js";
import { createSessionDelivery } from "./sessionDelivery/index.ts";
import { createAgentHistory } from "./agentHistory/index.js";
import { createTaskCenter } from "./taskCenter.js";
import { createCodexExecution } from "./codexExecution.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { applyAssignmentBusinessRules, buildAssignmentJsonSchema, buildAssignmentSystemPrompt, buildAssignmentUserPayload, isAssignmentCandidate, normalizeAssignmentPeople, normalizeAssignmentRecommendation } from "./assignmentEngine.js";
import { DEFAULT_OPERATION_LOG_ENDPOINT, uploadOperationLogs } from "./operationLogClient.js";
import { createIssueSource, issueSourceConfig, issueSourceId, sourceStorageKey, syncCheckpoint } from "./issueSources/index.ts";
import {
  buildIdeCommand,
  buildIdeExecArgs,
  getIdeExecutable,
  getIdeExecutorLabel,
  normalizeClaudeModel,
  normalizeCodexModel,
  normalizeIdeExecutor,
  normalizeReasoningEffort
} from "./ideExecutor.js";
import { classifyBugRoute, hydrateWorkflowIdeReports, normalizeBugInfo, runFixWorkflow, updateWorkflowOperationLogOutput } from "./workflowEngine.js";
import {
  buildUserSnapshot,
  createExecutionRecord,
  recoverInterruptedRuns,
  resolveUserStorageKey
} from "./workflowStore.js";

// Each instance owns its state, credentials, timers and child-process callbacks for its entire lifetime.
// Never switch a process-global current tenant when handling requests.
export function createTenantRuntime({ database, tenant, environment, rootDir, validateWorkspace = () => {} }) {
const requestIdentity = new AsyncLocalStorage();
const __dirname = rootDir;
const maxAttachmentDownloadBytes = 50 * 1024 * 1024;
const maxSupplementUploadBytes = 30 * 1024 * 1024;
const maxSupplementImageBytes = 10 * 1024 * 1024;
const maxSupplementImages = 8;
const gunzipAsync = promisify(gunzip);
const mode = issueSourceId(environment);
const storedSettings = database.readSettings(tenant.id);
const persistedConfig = storedSettings.config;
const persistedAssignmentPeople = normalizeAssignmentPeople(storedSettings.assignmentPeople, { fallback: [] });

const state = {
  config: {
    mode,
    assignee: persistedConfig.assignee ?? "",
    operatorId: persistedConfig.operatorId ?? "",
    selfOnly: persistedConfig.selfOnly ?? false,
    ...issueSourceConfig({ environment, config: persistedConfig }),
    intervalMinutes: clampNumber(persistedConfig.intervalMinutes ?? environment.POLL_INTERVAL_MINUTES, 1, 240, 30),
    ideExecutor: normalizeIdeExecutor(persistedConfig.ideExecutor ?? environment.IDE_EXECUTOR ?? "codex"),
    codexWorkspaceDir: environment.CODEX_WORKSPACE_DIR ? resolveWorkspaceDir(environment.CODEX_WORKSPACE_DIR) : (tenant.id === "default" ? resolveWorkspaceDir(persistedConfig.codexWorkspaceDir || __dirname) : ""),
    codexModel: normalizeCodexModel(persistedConfig.codexModel ?? environment.CODEX_MODEL ?? "gpt-5.6-sol"),
    claudeModel: normalizeClaudeModel(persistedConfig.claudeModel ?? environment.CLAUDE_MODEL ?? "claude-opus-4-8"),
    codexReasoningEffort: normalizeReasoningEffort(persistedConfig.codexReasoningEffort ?? environment.CODEX_REASONING_EFFORT ?? "medium"),
    codexBaseBranch: normalizeGitRef(persistedConfig.codexBaseBranch ?? environment.CODEX_BASE_BRANCH ?? "main", "main"),
    codexReviewMaxRounds: clampNumber(persistedConfig.codexReviewMaxRounds ?? environment.CODEX_REVIEW_MAX_ROUNDS, 1, 10, 3),
    enableBugInfoCompletion: parseBooleanConfig(persistedConfig.enableBugInfoCompletion, environment.ENABLE_BUG_INFO_COMPLETION, true),
    allowSkipInfoCompletion: parseBooleanConfig(persistedConfig.allowSkipInfoCompletion, environment.ALLOW_SKIP_INFO_COMPLETION, true),
    enableAIRouting: parseBooleanConfig(persistedConfig.enableAIRouting, environment.ENABLE_AI_ROUTING, true),
    enableAIAssignment: parseBooleanConfig(persistedConfig.enableAIAssignment, environment.ENABLE_AI_ASSIGNMENT, true),
    enableAutoAssignment: parseBooleanConfig(persistedConfig.enableAutoAssignment, environment.ENABLE_AUTO_ASSIGNMENT, false),
    aiAssignmentModel: normalizeCodexModel(persistedConfig.aiAssignmentModel ?? environment.AI_ASSIGNMENT_MODEL ?? "gpt-5.4-mini"),
    aiRoutingModel: normalizeCodexModel(persistedConfig.aiRoutingModel ?? environment.AI_ROUTING_MODEL ?? environment.CODEX_MODEL ?? "gpt-5.6-sol"),
    aiRoutingBaseUrl: normalizeUrl(persistedConfig.aiRoutingBaseUrl ?? environment.OPENAI_BASE_URL ?? "https://api.openai.com/v1", "https://api.openai.com/v1"),
    aiRoutingTimeoutMs: clampNumber(persistedConfig.aiRoutingTimeoutMs ?? environment.AI_ROUTING_TIMEOUT_MS, 5000, 120000, 30000),
    allowedAutoFixPriorities: normalizePriorityList(persistedConfig.allowedAutoFixPriorities ?? environment.ALLOWED_AUTO_FIX_PRIORITIES ?? "P2,P3"),
    requireVerificationReport: parseBooleanConfig(persistedConfig.requireVerificationReport, environment.REQUIRE_VERIFICATION_REPORT, true),
    requireRegressionTest: parseBooleanConfig(persistedConfig.requireRegressionTest, environment.REQUIRE_REGRESSION_TEST, false),
    requireHumanReview: parseBooleanConfig(persistedConfig.requireHumanReview, environment.REQUIRE_HUMAN_REVIEW, true),
    enableOperationLogUpload: parseBooleanConfig(persistedConfig.enableOperationLogUpload, environment.ENABLE_OPERATION_LOG_UPLOAD, Boolean(environment.OPERATION_LOG_COOKIE || environment.OPERATION_LOG_TOKEN)),
    operationLogBaseUrl: normalizeUrl(persistedConfig.operationLogBaseUrl ?? environment.OPERATION_LOG_BASE_URL ?? "https://logs.example.com", "https://logs.example.com"),
    operationLogEndpoint: persistedConfig.operationLogEndpoint || environment.OPERATION_LOG_ENDPOINT || DEFAULT_OPERATION_LOG_ENDPOINT,
    operationLogChatSource: persistedConfig.operationLogChatSource ?? environment.OPERATION_LOG_CHAT_SOURCE ?? "yonclaw_cloud",
    operationLogSourceType: persistedConfig.operationLogSourceType ?? environment.OPERATION_LOG_SOURCE_TYPE ?? "builtin",
    operationLogSessionId: persistedConfig.operationLogSessionId ?? environment.OPERATION_LOG_SESSION_ID ?? "",
    operationLogUserId: persistedConfig.operationLogUserId ?? environment.OPERATION_LOG_USER_ID ?? "",
    operationLogCreateName: persistedConfig.operationLogCreateName ?? environment.OPERATION_LOG_CREATE_NAME ?? "",
    operationLogDigitalCode: persistedConfig.operationLogDigitalCode ?? environment.OPERATION_LOG_DIGITAL_CODE ?? "auto_bug_workflow",
    operationLogAgentName: persistedConfig.operationLogAgentName ?? environment.OPERATION_LOG_AGENT_NAME ?? "Auto Bug Workflow",
    operationLogAgentVersion: persistedConfig.operationLogAgentVersion ?? environment.OPERATION_LOG_AGENT_VERSION ?? "0.1.0"
  },
  assignmentPeople: persistedAssignmentPeople,
  scheduler: {
    enabled: false,
    lastSyncTime: null,
    nextRunAt: null,
    lastRunStatus: "idle",
    lastRunMessage: "尚未执行同步"
  },
  bugs: [],
  runs: [],
  executionRecords: [],
  storageUserKey: ""
};

const workflowStore = database.createStore(tenant.id);
loadWorkflowUserState(sourceStorageKey(issueSource(), resolveUserStorageKey(state.config)));

let schedulerTimer = null;
let assignmentJobSeq = 0;
let assignmentBatchPromise = null;
let assignmentJobsPending = 0;
let mutationPending = false;
let closing = false;
const activeAssignmentBugIds = new Set();
const activeProcesses = new Map();
const activeVerificationProcesses = new Map();
const activeReviewProcesses = new Map();
const activeReviewLoops = new Set();
const BUG_ROUTE_TYPES = [
  "chat_session_conversation",
  "gateway_runtime",
  "host_api_boundary",
  "channel_messaging",
  "provider_model_config",
  "plugin_audit_runtime",
  "cron_task_delivery",
  "skills_agent_market",
  "auth_security_profile",
  "ui_i18n_theme",
  "build_package_platform",
  "docs_tests_tooling",
  "unknown"
];

async function persistAssignmentPeople() {
  database.writeSettings(tenant.id, { assignmentPeople: normalizeAssignmentPeople(state.assignmentPeople, { fallback: [] }) });
}

async function persistConfig() {
  database.writeSettings(tenant.id, { config: pickPersistedConfig(state.config) });
}

function loadWorkflowUserState(userKey) {
  const stored = workflowStore.readUserState(userKey);
  state.storageUserKey = stored.userKey;
  state.bugs = stored.bugs;
  state.runs = recoverInterruptedRuns(stored.runs).map(hydrateWorkflowIdeReports);
  state.executionRecords = stored.executionRecords;
}

async function persistWorkflowState({ immediate = false } = {}) {
  if (closing) return;
  const snapshot = {
    ...buildUserSnapshot(state),
    updatedAt: new Date().toISOString()
  };

  if (immediate) {
    await workflowStore.flushSave();
    await workflowStore.writeUserState(state.storageUserKey, snapshot);
    return;
  }

  workflowStore.scheduleSave(state.storageUserKey, snapshot);
}

function recordExecution(input = {}, { persist = true, immediate = false } = {}) {
  const actor = requestIdentity.getStore()?.user;
  input = { ...input, meta: { ...input.meta, actor: actor ? { id: actor.id, username: actor.username } : { username: "system" } } };
  state.executionRecords = workflowStore.appendExecutionRecord(state.executionRecords, input);
  if (persist) {
    persistWorkflowState({ immediate }).catch((error) => {
      console.warn(`Failed to persist execution record: ${error.message}`);
    });
  }
  return createExecutionRecord(input);
}

function recordRunExecution(run, event, message, { nodeId = "", meta = {}, immediate = false } = {}) {
  return recordExecution({
    runId: run?.id || "",
    bugId: run?.bugId || "",
    bugCode: run?.bugCode || "",
    event,
    message,
    status: run?.status || "",
    nodeId,
    meta
  }, { immediate });
}

async function switchWorkflowUserContext(nextConfig) {
  const nextUserKey = sourceStorageKey(issueSource(), resolveUserStorageKey(nextConfig));
  if (nextUserKey === state.storageUserKey) return;

  await persistWorkflowState({ immediate: true });
  loadWorkflowUserState(nextUserKey);
  state.scheduler.lastSyncTime = null;
  state.scheduler.lastRunStatus = "idle";
  state.scheduler.lastRunMessage = "已切换经办人，等待同步";
  recordExecution({
    event: "user-switched",
    message: `切换到用户 ${nextUserKey} 的本地数据。`,
    status: "done",
    meta: { userKey: nextUserKey }
  }, { immediate: true });
}

function pickPersistedConfig(config) {
  return {
    ...issueSourceConfig({ environment, config }),
    assignee: config.assignee,
    operatorId: config.operatorId,
    selfOnly: Boolean(config.selfOnly),
    intervalMinutes: config.intervalMinutes,
    ideExecutor: config.ideExecutor,
    codexWorkspaceDir: config.codexWorkspaceDir,
    codexModel: config.codexModel,
    claudeModel: config.claudeModel,
    codexReasoningEffort: config.codexReasoningEffort,
    codexBaseBranch: config.codexBaseBranch,
    codexReviewMaxRounds: config.codexReviewMaxRounds,
    enableBugInfoCompletion: Boolean(config.enableBugInfoCompletion),
    allowSkipInfoCompletion: Boolean(config.allowSkipInfoCompletion),
    enableAIRouting: Boolean(config.enableAIRouting),
    enableAIAssignment: Boolean(config.enableAIAssignment),
    enableAutoAssignment: Boolean(config.enableAutoAssignment),
    aiAssignmentModel: config.aiAssignmentModel,
    aiRoutingModel: config.aiRoutingModel,
    aiRoutingBaseUrl: config.aiRoutingBaseUrl,
    aiRoutingTimeoutMs: config.aiRoutingTimeoutMs,
    allowedAutoFixPriorities: config.allowedAutoFixPriorities,
    requireVerificationReport: Boolean(config.requireVerificationReport),
    requireRegressionTest: Boolean(config.requireRegressionTest),
    requireHumanReview: Boolean(config.requireHumanReview),
    enableOperationLogUpload: Boolean(config.enableOperationLogUpload),
    operationLogBaseUrl: config.operationLogBaseUrl,
    operationLogEndpoint: config.operationLogEndpoint,
    operationLogChatSource: config.operationLogChatSource,
    operationLogSourceType: config.operationLogSourceType,
    operationLogSessionId: config.operationLogSessionId,
    operationLogUserId: config.operationLogUserId,
    operationLogCreateName: config.operationLogCreateName,
    operationLogDigitalCode: config.operationLogDigitalCode,
    operationLogAgentName: config.operationLogAgentName,
    operationLogAgentVersion: config.operationLogAgentVersion
  };
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/task-center/codex') {
    sendJson(res, 200, await codexExecution.targets()); return;
  }
  if (url.pathname === '/api/task-center/execute') {
    sendJson(res, 202, await codexExecution.execute(await readJson(req))); return;
  }
  if (url.pathname === '/api/task-center/execution-action') {
    sendJson(res, 200, await codexExecution.action(await readJson(req), requestIdentity.getStore().user)); return;
  }
  if (url.pathname === '/api/task-center') {
    if (req.method === 'GET') sendJson(res, 200, await taskCenter.snapshot());
    else sendJson(res, 200, await taskCenter.command(await readJson(req), requestIdentity.getStore().user));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/sessions") {
    sendJson(res, 200, await sessionDelivery.list(url.searchParams));
    return;
  }
  const deliveryRoute = /^\/api\/sessions\/([a-f0-9]{64})(?:\/(events|records))?$/.exec(url.pathname);
  if (req.method === "GET" && deliveryRoute) {
    const operation = deliveryRoute[2] === "records" ? "record" : deliveryRoute[2] || "detail";
    sendJson(res, 200, await sessionDelivery[operation](deliveryRoute[1], url.searchParams));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/agent-sessions") {
    sendJson(res, 200, await agentHistory.list(url.searchParams));
    return;
  }
  const historyDetail = /^\/api\/agent-sessions\/([a-f0-9]{64})$/.exec(url.pathname);
  if (req.method === "GET" && historyDetail) {
    sendJson(res, 200, await agentHistory.detail(historyDetail[1], url.searchParams));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    sendText(res, 200, JSON.stringify(getBootstrap()), "application/json; charset=utf-8");
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/workflows/records") {
    const limit = clampNumber(url.searchParams.get("limit"), 1, 500, 100);
    sendJson(res, 200, {
      userKey: state.storageUserKey,
      records: state.executionRecords.slice(0, limit)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/assignment/people") {
    sendJson(res, 200, { people: state.assignmentPeople });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/assignment/people") {
    const body = await readJson(req);
    const people = normalizeAssignmentPeople(body, { fallback: [] });
    state.assignmentPeople = people;
    await persistAssignmentPeople();
    sendJson(res, 200, getBootstrap());
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/config") {
    const body = await readJson(req);
    if (hasBackgroundWork()) {
      sendJson(res, 409, { error: "tenant_busy", message: "当前租户有后台任务执行中，请完成或停止任务后修改配置" });
      return;
    }
    validateWorkspace(body.codexWorkspaceDir ?? state.config.codexWorkspaceDir);
    const previousUserKey = state.storageUserKey;
    updateConfig(body);
    await switchWorkflowUserContext(state.config);
    await persistConfig();
    configureScheduler(state.scheduler.enabled);
    if (previousUserKey !== state.storageUserKey) {
      recordExecution({
        event: "config-updated",
        message: `配置已更新，当前本地数据用户：${state.storageUserKey}`,
        status: "done",
        meta: { previousUserKey, userKey: state.storageUserKey }
      }, { immediate: true });
    }
    sendJson(res, 200, getBootstrap());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sync") {
    if (assignmentJobsPending || assignmentBatchPromise) {
      sendJson(res, 409, { error: "tenant_busy", message: "AI 分配任务执行中，请稍后同步" });
      return;
    }
    const result = await syncBugs({ incremental: false });
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/issues/diagnostics") {
    const checks = await issueSource().diagnose();
    sendJson(res, 200, { checks });
    return;
  }

  const attachmentMatch = url.pathname.match(/^\/api\/bugs\/([^/]+)\/attachments$/);
  if (req.method === "GET" && attachmentMatch) {
    const bugId = decodeURIComponent(attachmentMatch[1]);
    const bug = state.bugs.find((item) => item.id === bugId || item.aid === bugId);

    if (!bug) {
      sendJson(res, 404, { error: "bug_not_found", message: "缺陷不存在" });
      return;
    }

    if (bug.attachmentsLoaded) {
      sendJson(res, 200, { bugId: bug.id, attachments: bug.attachments || [] });
      return;
    }

    const attachments = await issueSource().attachments(bug);

    bug.attachments = attachments;
    bug.attachmentsLoaded = true;
    bug.attachmentsError = "";
    sendJson(res, 200, { bugId: bug.id, attachments });
    return;
  }

  const assignmentRecommendMatch = url.pathname.match(/^\/api\/bugs\/([^/]+)\/assignment\/recommend$/);
  if (req.method === "POST" && assignmentRecommendMatch) {
    const bugId = decodeURIComponent(assignmentRecommendMatch[1]);
    const bug = state.bugs.find((item) => item.id === bugId || item.aid === bugId);

    if (!bug) {
      sendJson(res, 404, { error: "bug_not_found", message: "缺陷不存在" });
      return;
    }

    await ensureBugAttachmentsLoaded(bug);
    bug.assignmentRecommendation = await recommendBugAssignee(bug);
    sendJson(res, 200, { bug, recommendation: bug.assignmentRecommendation });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/assignments/apply-all") {
    const result = await applyReadyAssignments({ source: "manual-batch" });
    sendJson(res, 200, { result, ...getBootstrap() });
    return;
  }

  const assignmentApplyMatch = url.pathname.match(/^\/api\/bugs\/([^/]+)\/assignment\/apply$/);
  if (req.method === "POST" && assignmentApplyMatch) {
    const bugId = decodeURIComponent(assignmentApplyMatch[1]);
    const body = await readJson(req);
    const bug = state.bugs.find((item) => item.id === bugId || item.aid === bugId);

    if (!bug) {
      sendJson(res, 404, { error: "bug_not_found", message: "缺陷不存在" });
      return;
    }

    try {
      const result = await applyBugAssignment(bug, body || {});
      recordExecution({
        bugId: bug.id,
        bugCode: bug.code,
        event: "bug-assigned",
        message: `缺陷已分配给 ${bug.assignee || result.assigneeId}`,
        status: "assigned",
        meta: { assigneeId: result.assigneeId }
      });
      await persistWorkflowState({ immediate: true });
      sendJson(res, 200, { bug, result });
    } catch (error) {
      const message = sanitizeError(error);
      bug.assignmentRecommendation = {
        ...(bug.assignmentRecommendation || {}),
        status: "assign-failed",
        assigned: false,
        error: message,
        failedAt: new Date().toISOString()
      };
      await persistWorkflowState();
      sendJson(res, 400, {
        error: "assignment_failed",
        message,
        bug,
        suggestion: "当前分配由数据源适配器执行，仅支持待处理和处理中的问题；请确认目标人员 ID 与数据源匹配。"
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/scheduler") {
    const body = await readJson(req);
    state.scheduler.enabled = Boolean(body.enabled);
    configureScheduler(state.scheduler.enabled);
    sendJson(res, 200, getBootstrap());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/workflows/run") {
    const body = await readJson(req);
    const bug = state.bugs.find((item) => item.id === body.bugId);

    if (!bug) {
      sendJson(res, 404, { error: "bug_not_found", message: "缺陷不存在" });
      return;
    }

    await ensureBugAttachmentsLoaded(bug);
    await localizeBugAttachments(bug, resolveWorkspaceDir(state.config.codexWorkspaceDir));
    const executionMode = body.executionMode === "auto" ? "auto" : "manual";
    const ideExecutor = normalizeIdeExecutor(body.ideExecutor ?? state.config.ideExecutor);
    const startExecution = body.startExecution !== false;
    const routing = await classifyBugRouteForWorkflow(bug);
    const run = runFixWorkflow(bug, state.config, { executionMode, startExecution, routingOverride: routing, ideExecutor });
    run.gitBranch = buildBugBranchName(run.bugCode);

    try {
      await prepareGitBranch(run, resolveWorkspaceDir(state.config.codexWorkspaceDir));
      run.codexHandoff = await saveCodexTask(run);
    } catch (error) {
      markRunFailed(run, sanitizeError(error));
      state.runs.unshift(run);
      bug.automationState = run.status;
      bug.lastRunId = run.id;
      recordRunExecution(run, "run-created", `创建${executionMode === "auto" ? "自动" : "人工"}流水线（分支准备失败）`, { immediate: true });
      await persistWorkflowState({ immediate: true });
      sendJson(res, 200, { run, bug });
      return;
    }

    const handoffStep = run.steps.find((step) => step.id === "handoff");
    if (handoffStep) {
      handoffStep.message = `已写入 ${run.codexHandoff.relativeTaskPath}，可用 ${getIdeExecutorLabel(run.ideExecutor)} CLI 执行。`;
    }
    state.runs.unshift(run);
    bug.automationState = run.status;
    bug.lastRunId = run.id;
    if (startExecution) {
      await startIdeExecution(run);
      bug.automationState = run.status;
    }
    recordRunExecution(run, "run-created", `创建${executionMode === "auto" ? "自动" : "人工"}流水线`, {
      immediate: true,
      meta: { executionMode, ideExecutor, startExecution }
    });
    await persistWorkflowState({ immediate: true });
    sendJson(res, 200, { run, bug });
    return;
  }

  const supplementMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/supplement$/);
  if (req.method === "POST" && supplementMatch) {
    const runId = decodeURIComponent(supplementMatch[1]);
    const run = state.runs.find((item) => item.id === runId);

    if (!run) {
      sendJson(res, 404, { error: "run_not_found", message: "流水线不存在" });
      return;
    }

    if (run.status === "running" || run.process?.status === "running") {
      sendJson(res, 400, { error: "run_running", message: "IDE 任务执行中，不能修改补充信息。" });
      return;
    }

    try {
      await applyRunSupplement(run, req);
      const bug = state.bugs.find((item) => item.id === run.bugId);
      recordRunExecution(run, "run-supplemented", "更新 IDE 执行前补充信息");
      await persistWorkflowState();
      sendJson(res, 200, { run, bug });
    } catch (error) {
      sendJson(res, 400, { error: "supplement_failed", message: sanitizeError(error) });
    }
    return;
  }

  const startMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/start$/);
  if (req.method === "POST" && startMatch) {
    const runId = decodeURIComponent(startMatch[1]);
    const run = state.runs.find((item) => item.id === runId);

    if (!run) {
      sendJson(res, 404, { error: "run_not_found", message: "流水线不存在" });
      return;
    }

    await startIdeExecution(run);
    const bug = state.bugs.find((item) => item.id === run.bugId);
    if (bug) bug.automationState = run.status;
    recordRunExecution(run, "run-started", "启动 IDE 任务");
    await persistWorkflowState();
    sendJson(res, 200, { run, bug });
    return;
  }

  const stopMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/stop$/);
  if (req.method === "POST" && stopMatch) {
    const runId = decodeURIComponent(stopMatch[1]);
    const body = await readJson(req);
    const run = state.runs.find((item) => item.id === runId);

    if (!run) {
      sendJson(res, 404, { error: "run_not_found", message: "流水线不存在" });
      return;
    }

    if (body.target === "verify") {
      stopVerification(run);
    } else if (body.target === "review") {
      stopReview(run);
    } else {
      stopIdeExecution(run);
    }
    await reportRunOperationLogIfReady(run);
    const bug = state.bugs.find((item) => item.id === run.bugId);
    if (bug) bug.automationState = run.status;
    recordRunExecution(run, "run-stopped", `停止任务：${body.target || "ide"}`);
    await persistWorkflowState();
    sendJson(res, 200, { run, bug });
    return;
  }

  const reviewStartMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/review\/start$/);
  if (req.method === "POST" && reviewStartMatch) {
    sendJson(res, 400, { error: "review_start_disabled", message: "当前工作流使用 Loop 人工 Review，不再启动独立 Review 会话。" });
    return;
  }

  const verifyStartMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/verify\/start$/);
  if (req.method === "POST" && verifyStartMatch) {
    sendJson(res, 400, { error: "verify_start_disabled", message: "当前工作流由 IDE Agent 执行自动化测试并生成验证报告，不再单独启动 npm run dev 验证节点。" });
    return;
  }

  const nodeMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/nodes\/([^/]+)\/complete$/);
  if (req.method === "POST" && nodeMatch) {
    const runId = decodeURIComponent(nodeMatch[1]);
    const nodeId = decodeURIComponent(nodeMatch[2]);
    const body = await readJson(req);
    const run = state.runs.find((item) => item.id === runId);

    if (!run) {
      sendJson(res, 404, { error: "run_not_found", message: "流水线不存在" });
      return;
    }

    completeWorkflowNode(run, nodeId, body);
    await reportRunOperationLogIfReady(run);
    const bug = state.bugs.find((item) => item.id === run.bugId);
    if (bug) bug.automationState = run.status;
    recordRunExecution(run, "node-completed", `完成节点 ${nodeId}`, { nodeId, meta: { result: body?.result || "" } });
    await persistWorkflowState();
    sendJson(res, 200, { run, bug });
    return;
  }

  const operationLogUploadMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/operation-log\/upload$/);
  if (req.method === "POST" && operationLogUploadMatch) {
    const runId = decodeURIComponent(operationLogUploadMatch[1]);
    const run = state.runs.find((item) => item.id === runId);

    if (!run) {
      sendJson(res, 404, { error: "run_not_found", message: "流水线不存在" });
      return;
    }

    try {
      const result = await uploadRunOperationLog(run, { force: true });
      sendJson(res, 200, { run, result });
    } catch (error) {
      sendJson(res, 400, { error: "operation_log_upload_failed", message: sanitizeError(error), run });
    }
    return;
  }

  sendJson(res, 404, { error: "not_found", message: "接口不存在" });
}

function getBootstrap() {
  return {
    ...(requestIdentity.getStore() ? publicIdentity(requestIdentity.getStore()) : {}),
    tenant: { id: tenant.id, name: tenant.name },
    storage: { driver: "sqlite", schemaVersion: 2 },
    config: {
      ...state.config,
      workspaceManaged: Boolean(environment.CODEX_WORKSPACE_DIR) || database.listTenants().length > 1,
      issueSourceLabel: issueSource().label,
      issueSourceConfigured: issueSource().configured,
      aiRoutingKeyConfigured: Boolean(environment.OPENAI_API_KEY),
      operationLogCredentialConfigured: Boolean(environment.OPERATION_LOG_COOKIE || environment.OPERATION_LOG_TOKEN)
    },
    scheduler: state.scheduler,
    assignmentPeople: state.assignmentPeople,
    storageUserKey: state.storageUserKey,
    bugs: state.bugs,
    runs: state.runs.slice(0, 100),
    executionRecords: state.executionRecords.slice(0, 100),
    metrics: buildMetrics()
  };
}

function buildMetrics() {
  const statusMetrics = calculateStatusMetrics(state.bugs);

  return {
    total: state.bugs.length,
    pending: statusMetrics.pending,
    processing: statusMetrics.processing,
    resolved: statusMetrics.resolved,
    other: statusMetrics.other,
    ready: state.bugs.filter((bug) => bug.automationState === "ready").length,
    validated: state.bugs.filter((bug) => ["validated", "reviewed", "closed"].includes(bug.automationState)).length,
    review: state.bugs.filter((bug) => ["awaiting-review", "needs-review"].includes(bug.automationState)).length,
    byStatus: statusMetrics.byStatus
  };
}

function calculateStatusMetrics(bugs) {
  const metrics = {
    pending: 0,
    processing: 0,
    resolved: 0,
    other: 0,
    byStatus: {}
  };

  for (const bug of bugs) {
    const key = statusGroupOf(bug.status);
    metrics[key] += 1;
    const status = bug.status || "未知";
    metrics.byStatus[status] = (metrics.byStatus[status] || 0) + 1;
  }

  return metrics;
}

function statusGroupOf(status) {
  const value = String(status || "").toLowerCase();
  if (/待处理|未处理|待受理|待确认|待分配|open|new|todo|pending|onaudit/.test(value)) return "pending";
  if (/处理中|处理|进行中|修复中|in progress|doing|processing|develop|fix/.test(value)) return "processing";
  if (/已解决|已关闭|已完成|关闭|解决|完成|resolved|closed|done|finish/.test(value)) return "resolved";
  return "other";
}

function isAssignableBugStatus(status) {
  return ["pending", "processing"].includes(statusGroupOf(status));
}

async function classifyBugRouteForWorkflow(bug) {
  const normalized = normalizeBugInfo(bug, state.config);
  if (state.config.enableAIRouting === false) {
    console.info(`[ai-routing] skipped: enableAIRouting=false bug=${bug.code || bug.id || "unknown"}`);
    return classifyBugRoute(bug, normalized, state.config);
  }

  try {
    return await classifyBugRouteWithModel(bug, normalized);
  } catch (error) {
    const fallback = classifyBugRoute(bug, normalized, state.config);
    console.warn(`[ai-routing] fallback bug=${bug.code || bug.id || "unknown"} error=${sanitizeError(error)}`);
    return {
      ...fallback,
      source: "local-rule-fallback",
      reason: `模型分类失败，已使用本地规则兜底：${sanitizeError(error)}`
    };
  }
}

async function classifyBugRouteWithModel(bug, normalized) {
  const accessKey = environment.OPENAI_API_KEY;
  if (!accessKey) {
    throw new Error("未配置 OPENAI_API_KEY，无法调用模型分类。");
  }

  const model = normalizeCodexModel(state.config.aiRoutingModel || state.config.codexModel);
  const baseUrl = normalizeUrl(state.config.aiRoutingBaseUrl, "https://api.openai.com/v1").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), state.config.aiRoutingTimeoutMs).unref();
  const startedAt = Date.now();
  const requestMeta = {
    bugCode: bug.code || bug.id || "unknown",
    model,
    baseUrl,
    timeoutMs: state.config.aiRoutingTimeoutMs,
    allowedAutoFixPriorities: state.config.allowedAutoFixPriorities,
    title: bug.title || ""
  };
  console.info(`[ai-routing] request ${JSON.stringify(requestMeta)}`);

  try {
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessKey}`
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: [
              "你是项目 研发缺陷路由分类器。只输出 JSON，不要输出 Markdown、解释文字或代码块。",
              "",
              "结合缺陷提供的项目背景、技术栈和模块信息进行分类，不推测未提供的内部架构。",
              "根据缺陷信息判断以下字段：",
              "{",
              "  \"bugType\": string,",
              "  \"priority\": \"P0\" | \"P1\" | \"P2\" | \"P3\",",
              "  \"needsHumanIntervention\": boolean,",
              "  \"reason\": string",
              "}",
              "",
              "bugType 只能从以下枚举中选择最匹配的一项：",
              "- \"chat_session_conversation\"",
              "- \"gateway_runtime\"",
              "- \"host_api_boundary\"",
              "- \"channel_messaging\"",
              "- \"provider_model_config\"",
              "- \"plugin_audit_runtime\"",
              "- \"cron_task_delivery\"",
              "- \"skills_agent_market\"",
              "- \"auth_security_profile\"",
              "- \"ui_i18n_theme\"",
              "- \"build_package_platform\"",
              "- \"docs_tests_tooling\"",
              "- \"unknown\"",
              "",
              "优先级规则：",
              "- P0：安全/隐私泄露、API Key 或登录态泄露、越权访问、数据不可恢复丢失、应用无法启动、Gateway 全量不可用、生产包不可用、会导致大面积用户无法完成核心 AI 对话。",
              "- P1：影响核心功能但仍有局部绕过方式，包括发送消息失败、对话历史错误、会话串线、sessionKey/sessionId/transcript 错乱、聊天事件丢失、Gateway 启停/重连异常、Channels 消息收发失败、Provider 默认模型或密钥同步导致聊天不可用、Cron 会话/投递错误、审计/trace 关键链路缺失。",
              "- P2：局部功能异常，有明确绕过方式，不影响核心聊天主链路。例如 Settings 某个非关键配置显示错误、Agent Market/Skills 局部列表或状态异常、Models 页面统计偏差、单个非核心平台脚本失败。",
              "- P3：文案、样式、轻微 i18n/dark mode 问题、非阻断性体验问题、测试/文档/日志描述问题，且不影响核心功能和数据正确性。",
              "",
              "强制业务规则：",
              "- 只要缺陷涉及“会话、对话、聊天、Chat、conversation、session、sessionKey、sessionId、history、transcript、message timeline、channel conversation、Cron 会话历史”，priority 至少为 P1，bugType 优先选 \"chat_session_conversation\" 或 \"channel_messaging\"。",
              "- 如果上述会话/对话问题同时造成安全泄露、跨用户/跨智能体数据串线、不可恢复数据丢失或应用/Gateway 全量不可用，则判为 P0。",
              "- 涉及 renderer 直接绕过 host-api 调用 IPC、本地 HTTP Gateway、SQLite、文件系统或 worker 的问题，优先判为 \"host_api_boundary\"，通常为 P1；若造成安全或数据泄露则为 P0。",
              "- 涉及 OpenClaw Gateway 启停、健康检查、RPC、gateway:notification、gateway:chat-message、config.set、OpenClaw runtime config 写入的问题，优先判为 \"gateway_runtime\"，通常为 P1。",
              "- 涉及 Provider API Key、keytar、auth-profiles、auth-state、默认模型、模型 fallback、开放平台托管默认模型的问题，优先判为 \"provider_model_config\"；泄露密钥或登录态为 P0。",
              "- 涉及 audit-logger、trace upload、llm_input、model_call、tool call、file operation、message send/receive 审计缺失的问题，优先判为 \"plugin_audit_runtime\"；若影响合规追踪或安全审计通常为 P1。",
              "- P0/P1 默认 needsHumanIntervention=true。",
              "- P2/P3 如果影响范围清晰、可由 IDE 自动修改和验证，则 needsHumanIntervention=false；如果需要产品判断、账号/密钥、外部服务、真实设备、人工登录、发布决策或跨团队确认，则 needsHumanIntervention=true。",
              "",
              "reason 要简短说明：",
              "1. 命中的关键事实；",
              "2. 为什么归到该 bugType；",
              "3. 为什么是该 priority；",
              "4. 是否需要人工介入的原因。",
              "",
              "只输出合法 JSON。不要输出多余字段。不要输出 Markdown。"
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              bug: {
                code: bug.code,
                title: bug.title,
                status: bug.status,
                priority: bug.priority,
                severity: bug.severity,
                product: bug.product,
                category: bug.category,
                description: bug.description,
                expected: bug.expected,
                actual: bug.actual,
                attachments: (bug.attachments || []).map((attachment) => ({
                  name: attachment.name,
                  url: attachment.url
                }))
              },
              normalized,
              outputSchema: {
                bugType: BUG_ROUTE_TYPES.join(" | "),
                priority: "P0 | P1 | P2 | P3",
                needsHumanIntervention: "boolean",
                reason: "string"
              }
            })
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "bug_route",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                bugType: {
                  type: "string",
                  enum: BUG_ROUTE_TYPES
                },
                priority: {
                  type: "string",
                  enum: ["P0", "P1", "P2", "P3"]
                },
                needsHumanIntervention: {
                  type: "boolean"
                },
                reason: {
                  type: "string"
                }
              },
              required: ["bugType", "priority", "needsHumanIntervention", "reason"]
            }
          }
        }
      })
    });

    const payload = await response.json().catch(() => ({}));
    const elapsedMs = Date.now() - startedAt;
    console.info(`[ai-routing] response bug=${bug.code || bug.id || "unknown"} status=${response.status} elapsedMs=${elapsedMs}`);
    if (!response.ok) {
      throw new Error(`模型分类请求失败 HTTP ${response.status}: ${payload?.error?.message || JSON.stringify(payload)}`);
    }

    const text = extractResponseText(payload);
    const route = normalizeModelRoute(JSON.parse(text), { model });
    console.info(`[ai-routing] result bug=${bug.code || bug.id || "unknown"} ${JSON.stringify({
      source: route.source,
      model: route.model,
      bugType: route.bugType,
      priority: route.priority,
      ideAutofixAllowed: route.ideAutofixAllowed,
      needsHumanIntervention: route.needsHumanIntervention,
      reason: route.reason
    })}`);
    return route;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`模型分类超时：${state.config.aiRoutingTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const chunks = [];
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") chunks.push(content.text);
    }
  }

  const text = chunks.join("\n").trim();
  if (!text) throw new Error("模型分类响应为空。");
  return text;
}

function normalizeModelRoute(route, { model }) {
  const priority = ["P0", "P1", "P2", "P3"].includes(String(route?.priority || "").toUpperCase())
    ? String(route.priority).toUpperCase()
    : "P2";
  const allowed = normalizePriorityList(state.config.allowedAutoFixPriorities).includes(priority);
  const needsHumanIntervention = Boolean(route?.needsHumanIntervention) || ["P0", "P1"].includes(priority);
  const bugType = BUG_ROUTE_TYPES.includes(route?.bugType) ? route.bugType : "unknown";

  return {
    enabled: true,
    source: "model",
    model,
    bugType,
    priority,
    recommendedHandling: buildRouteRecommendation(priority, allowed),
    ideAutofixAllowed: allowed,
    needsHumanIntervention,
    reason: String(route?.reason || "模型已完成路由分类。").trim()
  };
}

function buildRouteRecommendation(priority, allowed) {
  if (["P0", "P1"].includes(priority)) return "人工主导，AI 辅助分析，不建议直接自动修复。";
  if (allowed && priority === "P2") return "进入 IDE 自主修复，人工 Review 后合并。";
  if (allowed && priority === "P3") return "优先尝试 IDE 自主修复，走轻量人工 Review。";
  return "不在自动修复优先级内，建议人工评估。";
}

function startAssignmentRecommendationsForBugs(bugs) {
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

async function runAssignmentRecommendationJob(jobId) {
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
  await persistWorkflowState({ immediate: true });
}

async function recommendBugAssignee(bug) {
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

  const model = normalizeCodexModel(state.config.aiAssignmentModel);
  const baseUrl = normalizeUrl(state.config.aiRoutingBaseUrl, "https://api.openai.com/v1").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), state.config.aiRoutingTimeoutMs).unref();
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
  } catch (error) {
    const message = error?.name === "AbortError" ? `模型分配超时：${state.config.aiRoutingTimeoutMs}ms` : sanitizeError(error);
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

async function postAssignmentModelRequest({ baseUrl, model, bug, signal }) {
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
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function applyBugAssignment(bug, body = {}) {
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

async function applyBugAssignmentUnlocked(bug, body = {}) {
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

async function applyReadyAssignments({ source = "manual-batch" } = {}) {
  if (assignmentBatchPromise) return assignmentBatchPromise;

  assignmentBatchPromise = runReadyAssignmentBatch({ source });
  try {
    return await assignmentBatchPromise;
  } finally {
    assignmentBatchPromise = null;
  }
}

async function runReadyAssignmentBatch({ source }) {
  const candidates = state.bugs.filter((bug) => isAssignmentCandidate(bug, isAssignableBugStatus));
  const results = [];

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
      recordExecution({
        bugId: bug.id,
        bugCode: bug.code,
        event: "bug-assigned",
        message: `${source === "auto" ? "自动" : "批量"}分配给 ${bug.assignee || result.assigneeId}`,
        status: "assigned",
        meta: { source, assigneeId: result.assigneeId }
      }, { persist: false });
    } catch (error) {
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
      recordExecution({
        bugId: bug.id,
        bugCode: bug.code,
        event: "bug-assignment-failed",
        message: `${source === "auto" ? "自动" : "批量"}分配失败：${message}`,
        status: "failed",
        meta: { source, assigneeId: recommendation.assigneeId }
      }, { persist: false });
    }

    if (index < candidates.length - 1 && state.config.requestDelayMs > 0) {
      await sleep(state.config.requestDelayMs);
    }
  }

  const success = results.filter((item) => item.ok).length;
  const failed = results.length - success;
  const summary = {
    ok: failed === 0,
    source,
    total: candidates.length,
    success,
    failed,
    results
  };

  recordExecution({
    event: "assignment-batch-completed",
    message: `${source === "auto" ? "自动" : "一键"}分配完成：成功 ${success} 条${failed ? `，失败 ${failed} 条` : ""}`,
    status: failed ? "attention" : "done",
    meta: { source, total: candidates.length, success, failed }
  }, { persist: false });
  await persistWorkflowState({ immediate: true });
  return summary;
}

async function startIdeExecution(run) {
  if (closing) return;
  if (run.status === "running" || run.process?.status === "running") {
    appendRunLog(run, "[ide] 当前流水线已在执行中，忽略重复启动。");
    return;
  }

  const executor = resolveIdeExecutor(run);
  if (run.routing?.ideAutofixAllowed === false) {
    appendRunLog(run, "[routing] 当前路由分类不建议进入 IDE 自主修复，请人工介入。");
    return;
  }

  run.gitBranch = run.gitBranch || buildBugBranchName(run.bugCode);
  const workspaceDir = run.codexHandoff?.workspaceDir || resolveWorkspaceDir(state.config.codexWorkspaceDir);

  try {
    await prepareGitBranch(run, workspaceDir);
    if (!isIdeTaskHandoffAvailable(run.codexHandoff)) {
      const action = run.codexHandoff ? "重新生成" : "补充生成";
      run.codexHandoff = await saveCodexTask(run, workspaceDir);
      appendRunLog(run, `[ide] ${action}任务文件 ${run.codexHandoff.relativeTaskPath}`);
    }
  } catch (error) {
    markRunFailed(run, sanitizeError(error));
    return;
  }

  const handoff = run.codexHandoff;
  resetHumanReviewState(run);
  markIdeExecutionRunning(run);

  run.status = "running";
  run.startedExecutionAt = new Date().toISOString();
  const source = run.executionMode === "auto" ? "auto" : "manual";
  const command = buildIdeCommand(executor, state.config, handoff.workspaceDir, handoff.taskPath);
  appendRunLog(run, `[${source}] ${command}`);

  const child = spawn(getIdeExecutable(executor), buildIdeExecArgs(executor, state.config, handoff.workspaceDir, handoff.taskPath), {
    cwd: handoff.workspaceDir,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    windowsHide: true
  });

  run.process = {
    pid: child.pid,
    status: "running",
    executor,
    startedAt: new Date().toISOString()
  };
  activeProcesses.set(run.id, child);
  appendRunLog(run, `[${source}] PID ${child.pid || "unknown"}`);

  child.stdout.on("data", (chunk) => appendRunLog(run, chunk.toString()));
  child.stderr.on("data", (chunk) => appendRunLog(run, chunk.toString()));

  child.on("error", (error) => {
    activeProcesses.delete(run.id);
    markRunFailed(run, `${getIdeExecutorLabel(executor)} 执行启动失败：${sanitizeError(error)}`);
    reportRunOperationLogIfReady(run).catch((uploadError) => markOperationLogUploadFailed(run, sanitizeError(uploadError)));
  });

  child.on("close", (code, signal) => {
    handleIdeExecutionClose(run, handoff, code, signal).catch((error) => {
      markRunFailed(run, sanitizeError(error));
      reportRunOperationLogIfReady(run).catch((uploadError) => markOperationLogUploadFailed(run, sanitizeError(uploadError)));
      const bug = state.bugs.find((item) => item.id === run.bugId);
      if (bug) bug.automationState = run.status;
    });
  });
}

async function handleIdeExecutionClose(run, handoff, code, signal) {
    activeProcesses.delete(run.id);
    run.finishedAt = new Date().toISOString();
    run.process = { ...run.process, status: "finished", exitCode: code, signal, finishedAt: run.finishedAt };

    if (run.stopRequested) {
      markRunStopped(run, "任务已停止。");
      await reportRunOperationLogIfReady(run);
      const bug = state.bugs.find((item) => item.id === run.bugId);
      if (bug) bug.automationState = run.status;
      return;
    }

    if (code === 0) {
      try {
        await mergeBugBranchToDailyBranch(run, handoff.workspaceDir);
        markRunExecutionCompleted(run, `IDE Agent 执行完成，已合并到 ${run.dailyBranch || run.git?.dailyBranchName || "个人当天验证分支"}，等待人工 Review。`);
      } catch (error) {
        if (run.stopRequested) {
          markRunStopped(run, "任务已停止。");
        } else {
          markRunFailed(run, `合并到个人当天验证分支失败：${sanitizeError(error)}`);
        }
      }
    } else {
      markRunFailed(run, `${getIdeExecutorLabel(resolveIdeExecutor(run))} 执行结束，进程退出码为 ${code}。`);
    }

    await reportRunOperationLogIfReady(run);
    const bug = state.bugs.find((item) => item.id === run.bugId);
    if (bug) bug.automationState = run.status;
    recordRunExecution(run, run.status === "awaiting-review" || run.status === "reviewed" ? "run-completed" : run.status === "stopped" ? "run-stopped" : "run-failed", `IDE 执行结束，状态：${run.status}`, {
      immediate: true,
      meta: { exitCode: code, signal }
    });
    await persistWorkflowState({ immediate: true });
}

async function startReviewLoop(run) {
  if (closing) return;
  if (activeReviewLoops.has(run.id)) {
    appendRunLog(run, "[review] Review 循环已在运行中，忽略重复启动。");
    return;
  }

  if (run.status === "running" || run.process?.status === "running") {
    appendRunLog(run, "[review] IDE 修复仍在执行，暂不能启动 Review。");
    return;
  }

  if (!run.codexHandoff?.workspaceDir) {
    markReviewFailed(run, "缺少 IDE 执行路径，无法启动 Review。");
    return;
  }

  activeReviewLoops.add(run.id);
  run.review = ensureReviewState(run);
  run.review.stopRequested = false;
  run.review.maxRounds = clampNumber(state.config.codexReviewMaxRounds, 1, 10, run.review.maxRounds || 3);
  if (!run.review.passed && run.review.currentRound >= run.review.maxRounds) {
    markReviewFailed(run, `Review 未通过，已达到最大轮数 ${run.review.maxRounds}。`);
    activeReviewLoops.delete(run.id);
    return;
  }
  run.status = "reviewing";
  updateStep(run, "review", "running", `准备开始 Review，最多 ${run.review.maxRounds} 轮。`);
  appendRunLog(run, `[review] start, max rounds ${run.review.maxRounds}`);

  try {
    while (!run.review.stopRequested && run.review.currentRound < run.review.maxRounds) {
      const round = run.review.currentRound + 1;
      run.review.currentRound = round;
      updateStep(run, "review", "running", `第 ${round}/${run.review.maxRounds} 轮：独立 Review 会话正在审查代码改动。`);

      await prepareGitBranch(run, run.codexHandoff.workspaceDir);
      const reviewHandoff = await saveReviewTask(run, round);
      const reviewOutput = await runIdeTaskProcess(run, reviewHandoff, {
        phase: "review",
        label: `review round ${round}`,
        round
      });
      if (run.review.stopRequested) {
        markReviewStopped(run, "Review 已停止。");
        return;
      }

      const reviewResult = parseReviewOutput(reviewOutput);
      run.review.rounds.push({
        round,
        status: reviewResult.passed ? "passed" : "changes_requested",
        summary: reviewResult.summary,
        comments: reviewResult.comments,
        rawOutput: trimReviewOutput(reviewOutput),
        reviewedAt: new Date().toISOString()
      });

      if (reviewResult.passed) {
        markReviewPassed(run, `第 ${round} 轮 Review 通过，等待人工验证。`);
        return;
      }

      if (round >= run.review.maxRounds) {
        markReviewFailed(run, `Review 未通过，已达到最大轮数 ${run.review.maxRounds}。`);
        return;
      }

      updateStep(run, "review", "running", `第 ${round} 轮 Review 要求修改，正在把意见交给修复会话。`);
      updateStep(run, "execute", "running", `正在按第 ${round} 轮 Review 意见继续修复。`);
      const fixHandoff = await saveReviewFixTask(run, round, reviewResult);
      await runIdeTaskProcess(run, fixHandoff, {
        phase: "review-fix",
        label: `review fix round ${round}`,
        round
      });
      if (run.review.stopRequested) {
        markReviewStopped(run, "Review 修复已停止。");
        return;
      }

      updateStep(run, "execute", "done", `第 ${round} 轮 Review 意见已交给修复会话处理。`);
    }
  } catch (error) {
    if (run.review?.stopRequested) {
      markReviewStopped(run, "Review 已停止。");
    } else {
      markReviewFailed(run, sanitizeError(error));
    }
  } finally {
    activeReviewLoops.delete(run.id);
    const bug = state.bugs.find((item) => item.id === run.bugId);
    if (bug) bug.automationState = run.status;
  }
}

function ensureReviewState(run) {
  return {
    maxRounds: clampNumber(run.review?.maxRounds ?? state.config.codexReviewMaxRounds, 1, 10, 3),
    currentRound: Number(run.review?.currentRound || 0),
    passed: Boolean(run.review?.passed),
    rounds: Array.isArray(run.review?.rounds) ? run.review.rounds : [],
    notes: run.review?.notes || "等待修复完成后启动 Review。",
    process: run.review?.process || null
  };
}

function resetHumanReviewState(run) {
  run.review = {
    required: state.config.requireHumanReview !== false,
    passed: false,
    result: "pending",
    notes: "等待 IDE 验证报告后进入人工 Review。"
  };
  run.ide = {
    ...(run.ide || {}),
    process: null
  };
  updateStep(run, "analysis", "ready", "等待启动 IDE 自主执行。");
  updateStep(run, "fixPlan", "pending", "等待复现与定位完成后生成 Fix Plan。");
  updateStep(run, "codeFix", "pending", "等待修复方案确认后编码实现。");
  updateStep(run, "autoTest", "pending", "等待编码完成后执行自动化测试。");
  updateStep(run, "verificationReport", "pending", "等待自动化测试完成后生成验证报告。");
  updateStep(run, "mergeDaily", "pending", "等待 IDE 验证报告后自动合并到个人当天验证分支。");
  updateStep(run, "humanReview", "pending", "等待 IDE 验证报告后进入人工 Review。");
  updateStep(run, "releaseClose", "pending", "等待人工 Review 通过后发布并回填关闭工单。");
}

function markIdeExecutionRunning(run) {
  updateStep(run, "analysis", "running", "IDE Agent 正在复现、定位并生成 Bug Analysis Report。");
  updateStep(run, "fixPlan", "pending", "等待根因分析完成后生成修复方案。");
  updateStep(run, "codeFix", "pending", "等待修复方案后编码实现。");
  updateStep(run, "autoTest", "pending", "等待编码完成后执行自动化测试。");
  updateStep(run, "verificationReport", "pending", "等待测试完成后生成验证报告。");
  updateStep(run, "mergeDaily", "pending", "等待 IDE 验证报告后自动合并到个人当天验证分支。");
  run.ide = {
    ...(run.ide || {}),
    process: {
      ...(run.ide?.process || {}),
      status: "running",
      startedAt: new Date().toISOString()
    }
  };
}

async function runIdeTaskProcess(run, handoff, { phase, label, round }) {
  if (closing) return;
  const executor = resolveIdeExecutor(run);
  return new Promise((resolve, reject) => {
    const output = [];
    const child = spawn(getIdeExecutable(executor), buildIdeExecArgs(executor, state.config, handoff.workspaceDir, handoff.taskPath), {
      cwd: handoff.workspaceDir,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true
    });

    run.review = ensureReviewState(run);
    run.review.process = {
      pid: child.pid,
      status: "running",
      phase,
      round,
      executor,
      taskPath: handoff.taskPath,
      startedAt: new Date().toISOString()
    };
    activeReviewProcesses.set(run.id, child);
    appendRunLog(run, `[${phase}] ${label}: ${buildIdeCommand(executor, state.config, handoff.workspaceDir, handoff.taskPath)}`);
    appendRunLog(run, `[${phase}] PID ${child.pid || "unknown"}`);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output.push(text);
      appendRunLog(run, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output.push(text);
      appendRunLog(run, text);
    });

    child.on("error", (error) => {
      activeReviewProcesses.delete(run.id);
      run.review.process = {
        ...run.review.process,
        status: "failed",
        error: sanitizeError(error),
        finishedAt: new Date().toISOString()
      };
      reject(error);
    });

    child.on("close", (code, signal) => {
      activeReviewProcesses.delete(run.id);
      run.review.process = {
        ...run.review.process,
        status: run.review.stopRequested ? "stopped" : "finished",
        exitCode: code,
        signal,
        finishedAt: new Date().toISOString()
      };

      if (run.review.stopRequested) {
        resolve(output.join(""));
        return;
      }

      if (code === 0) {
        resolve(output.join(""));
      } else {
        reject(new Error(`${label} failed with exit code ${code}`));
      }
    });
  });
}

function stopReview(run) {
  run.review = ensureReviewState(run);
  run.review.stopRequested = true;
  const child = activeReviewProcesses.get(run.id);
  if (!child) {
    appendRunLog(run, "[review] 当前没有可停止的 Review 进程。");
    if (run.status === "reviewing") {
      markReviewStopped(run, "服务端未找到 Review 进程，已停止 Review。");
    }
    return;
  }

  run.status = "stopping";
  run.review.process = {
    ...(run.review.process || {}),
    status: "stopping",
    stopRequestedAt: new Date().toISOString()
  };
  updateStep(run, "review", "stopping", "正在停止 Review。");
  appendRunLog(run, `[review] stopping PID ${child.pid}`);

  try {
    if (child.pid) {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch (error) {
    appendRunLog(run, `[review] SIGTERM failed: ${sanitizeError(error)}`);
    try {
      child.kill("SIGTERM");
    } catch {
      // The close handler or fallback below will settle the review process.
    }
  }

  setTimeout(() => {
    if (!activeReviewProcesses.has(run.id)) return;
    try {
      if (child.pid) {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
      appendRunLog(run, `[review] force killed PID ${child.pid}`);
    } catch (error) {
      appendRunLog(run, `[review] SIGKILL failed: ${sanitizeError(error)}`);
    }
  }, 5000).unref();
}

async function startVerification(run) {
  if (closing) return;
  if (run.status === "running" || run.process?.status === "running") {
    appendRunLog(run, "[verify] Codex 仍在执行，暂不能启动验证项目。");
    return;
  }

  if (!run.review?.passed) {
    appendRunLog(run, "[verify] Review 尚未通过，暂不能启动验证项目。");
    return;
  }

  if (["running", "stopping"].includes(run.validation?.process?.status)) {
    appendRunLog(run, "[verify] 验证项目已在运行中，忽略重复启动。");
    return;
  }

  const workspaceDir = run.codexHandoff?.workspaceDir || resolveWorkspaceDir(state.config.codexWorkspaceDir);
  run.gitBranch = run.gitBranch || buildBugBranchName(run.bugCode);

  try {
    await ensureWorkspaceDir(workspaceDir);
    await prepareGitBranch(run, workspaceDir);
  } catch (error) {
    markValidationFailed(run, sanitizeError(error));
    return;
  }

  const verifyStep = findStep(run, "verify");
  if (verifyStep) {
    verifyStep.status = "running";
    verifyStep.message = "已启动 npm run dev，请在项目页面人工验证。";
  }

  run.status = "validating";
  run.validation = {
    ...run.validation,
    command: "npm run dev",
    notes: "验证项目已启动，等待人工确认结果。",
    stopRequested: false
  };
  appendRunLog(run, `[verify] npm run dev (cwd: ${workspaceDir})`);

  const child = spawn("npm", ["run", "dev"], {
    cwd: workspaceDir,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    windowsHide: true
  });

  run.validation.process = {
    pid: child.pid,
    status: "running",
    command: "npm run dev",
    startedAt: new Date().toISOString()
  };
  activeVerificationProcesses.set(run.id, child);
  appendRunLog(run, `[verify] PID ${child.pid || "unknown"}`);

  child.stdout.on("data", (chunk) => appendRunLog(run, chunk.toString()));
  child.stderr.on("data", (chunk) => appendRunLog(run, chunk.toString()));

  child.on("error", (error) => {
    activeVerificationProcesses.delete(run.id);
    markValidationFailed(run, `验证项目启动失败：${sanitizeError(error)}`);
  });

  child.on("close", (code, signal) => {
    activeVerificationProcesses.delete(run.id);
    const finishedAt = new Date().toISOString();
    const stopRequested = Boolean(run.validation?.stopRequested);
    run.validation = {
      ...run.validation,
      process: {
        ...(run.validation?.process || {}),
        status: stopRequested ? "stopped" : "finished",
        exitCode: code,
        signal,
        finishedAt
      }
    };

    if (stopRequested) {
      if (!["validated", "needs-review"].includes(run.status)) {
        if (run.status === "validating") run.status = "manual-executed";
        updateStep(run, "verify", "ready", "验证项目已停止，等待人工确认验证结果。");
      }
      appendRunLog(run, "[verify] 验证项目已停止。");
    } else if (code === 0) {
      if (run.status === "validating") run.status = "manual-executed";
      updateStep(run, "verify", "ready", "验证项目已退出，等待人工确认验证结果。");
      appendRunLog(run, "[verify] npm run dev 已退出，等待人工确认。");
    } else {
      markValidationFailed(run, `npm run dev 已退出，进程退出码为 ${code}。`);
    }

    const bug = state.bugs.find((item) => item.id === run.bugId);
    if (bug) bug.automationState = run.status;
  });
}

function stopIdeExecution(run) {
  const child = activeProcesses.get(run.id);
  if (!child) {
    appendRunLog(run, "[stop] 当前没有可停止的活动进程。");
    if (run.status === "running") {
      markRunStopped(run, "服务端未找到活动进程，已将流水线标记为停止。");
    }
    return;
  }

  run.stopRequested = true;
  run.status = "stopping";
  run.process = { ...run.process, status: "stopping", stopRequestedAt: new Date().toISOString() };
  updateStep(run, "analysis", "stopping", "正在停止 IDE 自主执行。");
  appendRunLog(run, `[stop] stopping PID ${child.pid}`);

  try {
    if (child.pid) {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch (error) {
    appendRunLog(run, `[stop] SIGTERM failed: ${sanitizeError(error)}`);
    try {
      child.kill("SIGTERM");
    } catch {
      // The close handler or fallback below will settle the run.
    }
  }

  setTimeout(() => {
    if (!activeProcesses.has(run.id)) return;
    try {
      if (child.pid) {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
      appendRunLog(run, `[stop] force killed PID ${child.pid}`);
    } catch (error) {
      appendRunLog(run, `[stop] SIGKILL failed: ${sanitizeError(error)}`);
    }
  }, 5000).unref();
}

function stopVerification(run) {
  const child = activeVerificationProcesses.get(run.id);
  if (!child) {
    appendRunLog(run, "[verify] 当前没有可停止的验证进程。");
    if (run.status === "validating") {
      run.status = "manual-executed";
      updateStep(run, "verify", "ready", "服务端未找到验证进程，等待人工确认验证结果。");
    }
    return;
  }

  run.validation = {
    ...run.validation,
    stopRequested: true,
    process: {
      ...(run.validation?.process || {}),
      status: "stopping",
      stopRequestedAt: new Date().toISOString()
    }
  };
  updateStep(run, "verify", "stopping", "正在停止验证项目。");
  appendRunLog(run, `[verify] stopping PID ${child.pid}`);

  try {
    if (child.pid) {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch (error) {
    appendRunLog(run, `[verify] SIGTERM failed: ${sanitizeError(error)}`);
    try {
      child.kill("SIGTERM");
    } catch {
      // The close handler or fallback below will settle the validation process.
    }
  }

  setTimeout(() => {
    if (!activeVerificationProcesses.has(run.id)) return;
    try {
      if (child.pid) {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
      appendRunLog(run, `[verify] force killed PID ${child.pid}`);
    } catch (error) {
      appendRunLog(run, `[verify] SIGKILL failed: ${sanitizeError(error)}`);
    }
  }, 5000).unref();
}

async function prepareGitBranch(run, workspaceDir) {
  await ensureWorkspaceDir(workspaceDir);
  const isGit = (await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd: workspaceDir })).stdout.trim();
  if (isGit !== "true") {
    throw new Error(`Codex 执行路径不是 Git 仓库：${workspaceDir}`);
  }

  const branchName = run.gitBranch || buildBugBranchName(run.bugCode);
  const bug = state.bugs.find((item) => item.id === run.bugId);
  const dailyBranchName = buildDailyBranchName(run, bug);
  const dailyOwner = resolveDailyBranchOwner(bug);
  const baseBranch = normalizeGitRef(state.config.codexBaseBranch, "main");
  const currentBranch = (await runCommand("git", ["branch", "--show-current"], { cwd: workspaceDir })).stdout.trim();
  run.gitBranch = branchName;
  run.dailyBranch = dailyBranchName;
  run.git = {
    ...(run.git || {}),
    branchName,
    dailyBranchName,
    dailyOwner,
    baseBranch,
    previousBranch: currentBranch || run.git?.previousBranch || "",
    workspaceDir
  };
  appendRunLog(run, `[git] ensuring bug branch ${branchName}`);

  if (currentBranch === branchName) {
    appendRunLog(run, `[git] already on ${branchName}`);
  } else {
    const blockingStatus = await getBlockingGitStatus(workspaceDir);
    if (blockingStatus) {
      throw new Error(`目标仓库存在未提交变更，请先提交或清理后再启动任务。当前分支：${currentBranch || "detached"}；目标分支：${branchName}；变更：${blockingStatus}`);
    }

    const exists = await commandSucceeds("git", ["rev-parse", "--verify", `refs/heads/${branchName}`], { cwd: workspaceDir });
    if (exists) {
      await runCommand("git", ["switch", branchName], { cwd: workspaceDir });
      appendRunLog(run, `[git] switched to existing branch ${branchName}`);
    } else {
      const baseRef = await resolveLatestBaseRef(run, workspaceDir, baseBranch);
      await runCommand("git", ["switch", "-c", branchName, baseRef], { cwd: workspaceDir });
      appendRunLog(run, `[git] created branch ${branchName} from ${baseRef}`);
    }
  }

  run.git.switchedAt = new Date().toISOString();
  await ensureDailyBranchExists(run, workspaceDir, dailyBranchName);
}

async function mergeBugBranchToDailyBranch(run, workspaceDir) {
  const bug = state.bugs.find((item) => item.id === run.bugId);
  const bugBranchName = run.gitBranch || run.git?.branchName || buildBugBranchName(run.bugCode);
  const dailyBranchName = buildDailyBranchName(run, bug);
  run.dailyBranch = dailyBranchName;
  run.git = {
    ...(run.git || {}),
    branchName: bugBranchName,
    dailyBranchName,
    mergeStatus: "running"
  };
  updateStep(run, "mergeDaily", "running", `正在把 ${bugBranchName} 合并到 ${dailyBranchName}。`);
  appendRunLog(run, `[git] preparing daily branch merge: ${bugBranchName} -> ${dailyBranchName}`);

  await ensureOnBranch(run, workspaceDir, bugBranchName);
  await stageAndCommitChanges(run, workspaceDir, `${run.bugCode}: Codex fix`);
  await prepareDailyBranch(run, workspaceDir, dailyBranchName);

  try {
    await runCommand("git", ["merge", "--no-ff", "--no-edit", bugBranchName], { cwd: workspaceDir });
    run.git.mergeStatus = "merged";
    run.git.mergedAt = new Date().toISOString();
    updateStep(run, "mergeDaily", "done", `已合并到个人当天验证分支 ${dailyBranchName}。`);
    appendRunLog(run, `[git] merged ${bugBranchName} into ${dailyBranchName}`);
    return;
  } catch (error) {
    run.git.mergeStatus = "conflict";
    run.git.mergeConflict = sanitizeError(error);
    updateStep(run, "mergeDaily", "running", "合并出现冲突，正在交给 Codex 自动解决。");
    appendRunLog(run, `[git] merge conflict: ${sanitizeError(error)}`);
  }

  const conflictHandoff = await saveMergeConflictTask(run, {
    workspaceDir,
    bugBranchName,
    dailyBranchName,
    conflict: run.git.mergeConflict
  });
  await runIdeMergeConflictProcess(run, conflictHandoff);
  await finalizeDailyMergeAfterConflict(run, workspaceDir, dailyBranchName);

  run.git.mergeStatus = "merged-after-conflict";
  run.git.mergedAt = new Date().toISOString();
  updateStep(run, "mergeDaily", "done", `冲突已由 ${getIdeExecutorLabel(resolveIdeExecutor(run))} 处理，并合并到 ${dailyBranchName}。`);
  appendRunLog(run, `[git] conflict resolved and merged into ${dailyBranchName}`);
}

async function ensureOnBranch(run, workspaceDir, branchName) {
  const currentBranch = (await runCommand("git", ["branch", "--show-current"], { cwd: workspaceDir })).stdout.trim();
  if (currentBranch === branchName) return;

  const blockingStatus = await getBlockingGitStatus(workspaceDir);
  if (blockingStatus) {
    throw new Error(`切换分支前存在未提交变更：${blockingStatus}`);
  }

  await runCommand("git", ["switch", branchName], { cwd: workspaceDir });
  appendRunLog(run, `[git] switched to ${branchName}`);
}

async function prepareDailyBranch(run, workspaceDir, dailyBranchName) {
  const currentBranch = (await runCommand("git", ["branch", "--show-current"], { cwd: workspaceDir })).stdout.trim();
  if (currentBranch === dailyBranchName) return;

  const blockingStatus = await getBlockingGitStatus(workspaceDir);
  if (blockingStatus) {
    throw new Error(`创建或切换日分支前存在未提交变更：${blockingStatus}`);
  }

  const exists = await commandSucceeds("git", ["rev-parse", "--verify", `refs/heads/${dailyBranchName}`], { cwd: workspaceDir });
  if (exists) {
    await runCommand("git", ["switch", dailyBranchName], { cwd: workspaceDir });
    appendRunLog(run, `[git] switched to daily branch ${dailyBranchName}`);
    return;
  }

  const baseBranch = normalizeGitRef(state.config.codexBaseBranch, "main");
  const baseRef = await resolveLatestBaseRef(run, workspaceDir, baseBranch);
  await runCommand("git", ["switch", "-c", dailyBranchName, baseRef], { cwd: workspaceDir });
  appendRunLog(run, `[git] created daily branch ${dailyBranchName} from ${baseRef}`);
}

async function ensureDailyBranchExists(run, workspaceDir, dailyBranchName) {
  const exists = await commandSucceeds("git", ["rev-parse", "--verify", `refs/heads/${dailyBranchName}`], { cwd: workspaceDir });
  if (exists) {
    appendRunLog(run, `[git] daily branch already exists ${dailyBranchName}`);
    return;
  }

  const baseBranch = normalizeGitRef(state.config.codexBaseBranch, "main");
  const baseRef = await resolveLatestBaseRef(run, workspaceDir, baseBranch);
  await runCommand("git", ["branch", dailyBranchName, baseRef], { cwd: workspaceDir });
  run.git = {
    ...(run.git || {}),
    dailyBranchName,
    dailyBranchCreatedAt: new Date().toISOString()
  };
  appendRunLog(run, `[git] created daily branch ${dailyBranchName} from ${baseRef}`);
}

async function stageAndCommitChanges(run, workspaceDir, message) {
  const status = await getBlockingGitStatus(workspaceDir);
  if (!status) {
    appendRunLog(run, "[git] no code changes to commit on bug branch");
    return false;
  }

  await runCommand("git", ["add", "-A", "--", "."], { cwd: workspaceDir });
  await resetGeneratedCodexPaths(workspaceDir);
  const noStagedChanges = await commandSucceeds("git", ["diff", "--cached", "--quiet"], { cwd: workspaceDir });
  if (noStagedChanges) {
    appendRunLog(run, "[git] no staged code changes after excluding task files");
    return false;
  }

  await runCommand("git", ["commit", "-m", message], { cwd: workspaceDir });
  appendRunLog(run, `[git] committed bug branch changes: ${message}`);
  return true;
}

async function finalizeDailyMergeAfterConflict(run, workspaceDir, dailyBranchName) {
  await ensureNoUnmergedPaths(workspaceDir);

  const mergeInProgress = await commandSucceeds("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: workspaceDir });
  if (mergeInProgress) {
    await runCommand("git", ["add", "-A", "--", "."], { cwd: workspaceDir });
    await resetGeneratedCodexPaths(workspaceDir);
    await runCommand("git", ["commit", "--no-edit"], { cwd: workspaceDir });
    appendRunLog(run, `[git] completed merge commit on ${dailyBranchName}`);
    return;
  }

  const status = await getBlockingGitStatus(workspaceDir);
  if (status) {
    await stageAndCommitChanges(run, workspaceDir, `${run.bugCode}: resolve daily branch merge conflict`);
  }
}

async function ensureNoUnmergedPaths(workspaceDir) {
  const unmerged = (await runCommand("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: workspaceDir })).stdout.trim();
  if (unmerged) {
    throw new Error(`仍存在未解决的合并冲突：${unmerged}`);
  }
}

async function getBlockingGitStatus(workspaceDir) {
  const status = (await runCommand("git", ["status", "--porcelain"], { cwd: workspaceDir })).stdout.trim();
  if (!status) return "";

  const blockingLines = status
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !isGeneratedCodexPath(gitStatusPath(line)));

  return blockingLines.join("; ");
}

async function resetGeneratedCodexPaths(workspaceDir) {
  await commandSucceeds("git", ["reset", "--", ".codex/tasks", ".codex/attachments", ".codex/supplements"], { cwd: workspaceDir });
}

function isGeneratedCodexPath(filePath) {
  return [".codex/tasks/", ".codex/attachments/", ".codex/supplements/"].some((prefix) => String(filePath || "").startsWith(prefix));
}

function gitStatusPath(line) {
  const value = String(line || "").slice(3).trim();
  const renamedTo = value.split(" -> ").pop() || value;
  return renamedTo.replace(/^"|"$/g, "");
}

async function resolveLatestBaseRef(run, workspaceDir, baseBranch) {
  const hasOrigin = await commandSucceeds("git", ["remote", "get-url", "origin"], { cwd: workspaceDir });
  if (hasOrigin) {
    appendRunLog(run, `[git] fetching origin ${baseBranch}`);
    await runCommand("git", ["fetch", "origin", baseBranch], { cwd: workspaceDir });
    const remoteRef = `refs/remotes/origin/${baseBranch}`;
    const remoteExists = await commandSucceeds("git", ["rev-parse", "--verify", remoteRef], { cwd: workspaceDir });
    if (remoteExists) {
      return `origin/${baseBranch}`;
    }
    throw new Error(`远端主分支不存在：origin/${baseBranch}`);
  }

  const localRef = `refs/heads/${baseBranch}`;
  const localExists = await commandSucceeds("git", ["rev-parse", "--verify", localRef], { cwd: workspaceDir });
  if (!localExists) {
    throw new Error(`本地主分支不存在：${baseBranch}`);
  }
  appendRunLog(run, `[git] using local base branch ${baseBranch}`);
  return baseBranch;
}

function completeWorkflowNode(run, nodeId, body = {}) {
  const step = findStep(run, nodeId);
  if (!step) {
    throw new Error(`流水线节点不存在：${nodeId}`);
  }

  const result = body.status === "attention" ? "attention" : "done";

  if (nodeId === "humanReview") {
    const message = String(body.message || (result === "done" ? "人工 Review 通过。" : "人工 Review 驳回，回到 IDE 自主修复。")).trim();
    if (result === "done") {
      markReviewPassed(run, message);
    } else {
      markReviewFailed(run, message);
    }
    return;
  }

  if (nodeId === "releaseClose") {
    const message = String(body.message || (result === "done" ? "已人工确认发布并关闭工单。" : "发布与关闭暂不通过，需继续复核。")).trim();
    if (state.config.requireHumanReview !== false && !run.review?.passed) {
      updateStep(run, "releaseClose", "blocked", "人工 Review 未通过，不能发布关闭。");
      appendRunLog(run, "[release] 人工 Review 未通过，不能发布关闭。");
      return;
    }
    if (result === "done") {
      markRunClosed(run, message);
    } else {
      markReleaseBlocked(run, message);
    }
    return;
  }

  step.status = result;
  step.message = String(body.message || (result === "done" ? "已人工标记完成。" : "已人工标记需复核。")).trim();
  appendRunLog(run, `[manual] ${step.label}: ${step.message}`);
}

async function reportRunOperationLogIfReady(run) {
  if (closing) return;
  if (!isOperationLogReportableStatus(run.status)) return null;
  return uploadRunOperationLog(run).catch((error) => {
    markOperationLogUploadFailed(run, sanitizeError(error));
    return null;
  });
}

async function uploadRunOperationLog(run, { force = false } = {}) {
  if (!run?.operationLog?.item) {
    throw new Error("当前流水线没有运营日志。");
  }

  refreshRunOperationLogOutput(run);
  const upload = run.operationLog.upload || {};
  run.operationLog.upload = {
    enabled: Boolean(upload.enabled || state.config.enableOperationLogUpload),
    status: upload.status || "pending",
    attempts: Number(upload.attempts || 0),
    lastResult: upload.lastResult || null,
    lastError: upload.lastError || ""
  };

  if (!force && !run.operationLog.upload.enabled) {
    run.operationLog.upload.status = "disabled";
    return { ok: false, skipped: true, reason: "operation log upload disabled" };
  }

  const cookie = environment.OPERATION_LOG_COOKIE;
  const token = environment.OPERATION_LOG_TOKEN;
  if (!cookie && !token) {
    throw new Error("缺少 OPERATION_LOG_COOKIE 或 OPERATION_LOG_TOKEN。");
  }

  run.operationLog.upload.status = "uploading";
  run.operationLog.upload.attempts += 1;
  const result = await uploadOperationLogs({
    baseUrl: state.config.operationLogBaseUrl,
    endpoint: run.operationLog.endpoint || state.config.operationLogEndpoint,
    cookie,
    token,
    items: [run.operationLog.item]
  });

  run.operationLog.upload.status = result.ok && result.rejected === 0 ? "uploaded" : "partial";
  run.operationLog.upload.lastResult = {
    accepted: result.accepted,
    rejected: result.rejected,
    failures: result.failures,
    uploadedAt: new Date().toISOString()
  };
  run.operationLog.upload.lastError = "";
  appendRunLog(run, `[operation-log] uploaded accepted=${result.accepted} rejected=${result.rejected}`);
  return result;
}

function refreshRunOperationLogOutput(run) {
  const status = operationLogStatusOfRun(run);
  updateWorkflowOperationLogOutput(run, {
    status,
    finishedAt: run.finishedAt || new Date().toISOString(),
    answerText: buildOperationLogAnswer(run, status)
  });
}

function buildOperationLogAnswer(run, status) {
  return [
    `工作流状态：${run.status}`,
    `运营日志状态：${status}`,
    `路由结果：${run.routing?.bugType || "未知"} / ${run.routing?.priority || "未知"}`,
    `验证结果：${run.validation?.passed ? "通过" : "未通过或待确认"}；${run.validation?.notes || ""}`,
    `Review 结果：${run.review?.result || "pending"}；${run.review?.notes || ""}`,
    run.releaseClose?.notes ? `发布关闭：${run.releaseClose.notes}` : "",
    run.git?.dailyBranchName || run.dailyBranch ? `日分支：${run.git?.dailyBranchName || run.dailyBranch}` : "",
    run.ide?.reports?.risks ? `风险说明：${run.ide.reports.risks}` : ""
  ].filter(Boolean).join("\n");
}

function operationLogStatusOfRun(run) {
  if (run.status === "stopped") return "user_abort";
  if (["needs-review", "failed"].includes(run.status)) return "failure";
  return "success";
}

function isOperationLogReportableStatus(status) {
  return ["awaiting-review", "reviewed", "closed", "needs-review", "stopped"].includes(status);
}

function markOperationLogUploadFailed(run, message) {
  if (!run?.operationLog) return;
  const upload = run.operationLog.upload || {};
  run.operationLog.upload = {
    ...upload,
    enabled: Boolean(upload.enabled || state.config.enableOperationLogUpload),
    status: "failed",
    attempts: Number(upload.attempts || 0),
    lastError: message,
    failedAt: new Date().toISOString()
  };
  appendRunLog(run, `[operation-log] upload failed: ${message}`);
}

function markRunExecutionCompleted(run, message) {
  hydrateWorkflowIdeReports(run);
  run.status = run.review?.required === false ? "reviewed" : "awaiting-review";
  run.ide = {
    ...(run.ide || {}),
    process: {
      ...(run.ide?.process || {}),
      status: "finished",
      finishedAt: new Date().toISOString()
    },
    reports: {
      ...(run.ide?.reports || {}),
      verification: "IDE Agent 已完成自动化测试并生成验证报告，详见执行日志和最终回复。",
      risks: "等待人工 Review 确认剩余风险。"
    }
  };
  updateStep(run, "analysis", "done", "已输出 Bug Analysis Report。");
  updateStep(run, "fixPlan", "done", "已输出 Fix Plan。");
  updateStep(run, "codeFix", "done", "已完成编码修复。");
  updateStep(run, "autoTest", "done", "已执行自动化测试，结果见验证报告。");
  updateStep(run, "verificationReport", "done", "已生成验证报告。");
  if (findStep(run, "mergeDaily")?.status !== "done") {
    updateStep(run, "mergeDaily", "done", `已合并到 ${run.dailyBranch || run.git?.dailyBranchName || "个人当天验证分支"}。`);
  }

  if (run.review?.required === false) {
    run.review = { ...(run.review || {}), passed: true, result: "skipped", notes: "配置未强制人工 Review，已跳过人工 Review。" };
    updateStep(run, "humanReview", "skipped", "配置未强制人工 Review，已跳过。");
    updateStep(run, "releaseClose", "ready", "验证报告已生成，可发布并回填关闭工单。");
  } else {
    updateStep(run, "humanReview", "ready", message);
    updateStep(run, "releaseClose", "pending", "等待人工 Review 通过后发布并回填关闭工单。");
  }

  appendRunLog(run, `[review] READY ${message}`);
  recordRunExecution(run, "run-awaiting-review", message);
}

function markReviewPassed(run, message) {
  run.status = "reviewed";
  run.review = {
    ...(run.review || {}),
    passed: true,
    result: "passed",
    notes: message,
    reviewedAt: new Date().toISOString()
  };
  updateStep(run, "humanReview", "done", message);
  updateStep(run, "releaseClose", "ready", "人工 Review 通过，可进入发布与关闭工单。");
  appendRunLog(run, `[review] PASS ${message}`);
}

function markReviewFailed(run, message) {
  run.status = "needs-review";
  run.review = {
    ...(run.review || {}),
    passed: false,
    result: "rejected",
    notes: message,
    reviewedAt: new Date().toISOString()
  };
  updateStep(run, "humanReview", "attention", message);
  updateStep(run, "releaseClose", "blocked", "人工 Review 未通过，暂不发布关闭。");
  updateStep(run, "analysis", "ready", "Review 驳回后可重新进入 IDE 自主修复。");
  appendRunLog(run, `[review] NEEDS_REVIEW ${message}`);
}

function markReviewStopped(run, message) {
  run.status = "stopped";
  run.review = {
    ...(run.review || {}),
    passed: false,
    notes: message
  };
  updateStep(run, "humanReview", "stopped", message);
  updateStep(run, "releaseClose", "blocked", "Review 停止后暂不发布关闭。");
  appendRunLog(run, `[review] STOPPED ${message}`);
}

function markRunClosed(run, message) {
  run.status = "closed";
  run.finishedAt = new Date().toISOString();
  run.releaseClose = {
    ...(run.releaseClose || {}),
    passed: true,
    notes: message,
    closedAt: run.finishedAt
  };
  updateStep(run, "releaseClose", "done", message);
  appendRunLog(run, `[release] CLOSED ${message}`);
}

function markReleaseBlocked(run, message) {
  run.status = "needs-review";
  run.releaseClose = {
    ...(run.releaseClose || {}),
    passed: false,
    notes: message
  };
  updateStep(run, "releaseClose", "attention", message);
  appendRunLog(run, `[release] NEEDS_REVIEW ${message}`);
}

function markRunValidated(run, message) {
  run.status = "validated";
  run.validation = {
    ...run.validation,
    passed: true,
    notes: message
  };
  updateStep(run, "execute", "done", "执行完成。");
  updateStep(run, "verify", "done", message);
  updateStep(run, "release", "ready", "验证通过，可准备问题状态更新。");
  appendRunLog(run, `[verify] PASS ${message}`);
}

function markValidationFailed(run, message) {
  run.status = "needs-review";
  run.validation = {
    ...run.validation,
    passed: false,
    command: "npm run dev",
    notes: message
  };
  updateStep(run, "verify", "attention", message);
  updateStep(run, "release", "blocked", "验证未通过，暂不更新问题状态。");
  appendRunLog(run, `[verify] NEEDS_REVIEW ${message}`);
}

function markRunFailed(run, message) {
  run.status = "needs-review";
  run.ide = {
    ...(run.ide || {}),
    process: {
      ...(run.ide?.process || {}),
      status: "failed",
      finishedAt: new Date().toISOString()
    },
    reports: {
      ...(run.ide?.reports || {}),
      risks: message
    }
  };
  run.validation = {
    ...run.validation,
    passed: false,
    notes: message
  };
  updateStep(run, "analysis", "attention", message);
  updateStep(run, "fixPlan", "pending", "等待重新启动 IDE 自主执行。");
  updateStep(run, "codeFix", "pending", "等待重新启动 IDE 自主执行。");
  updateStep(run, "autoTest", "pending", "等待重新启动 IDE 自主执行。");
  updateStep(run, "verificationReport", "attention", "IDE 执行未完成，验证报告不可用。");
  updateStep(run, "mergeDaily", "blocked", "IDE 执行或合并未完成，暂不能进入人工 Review。");
  updateStep(run, "humanReview", "blocked", "IDE 未完成技术闭环，暂不能人工 Review。");
  updateStep(run, "releaseClose", "blocked", "未通过 Review，暂不发布关闭。");
  appendRunLog(run, `[ide] NEEDS_REVIEW ${message}`);
}

function markRunStopped(run, message) {
  run.status = "stopped";
  run.finishedAt = run.finishedAt || new Date().toISOString();
  run.process = { ...run.process, status: "stopped", finishedAt: run.finishedAt };
  run.ide = {
    ...(run.ide || {}),
    process: {
      ...(run.ide?.process || {}),
      status: "stopped",
      finishedAt: run.finishedAt
    }
  };
  run.validation = {
    ...run.validation,
    passed: false,
    notes: message
  };
  updateStep(run, "analysis", "stopped", message);
  updateStep(run, "fixPlan", "pending", "任务已停止，等待重新执行或人工处理。");
  updateStep(run, "codeFix", "pending", "任务已停止，等待重新执行或人工处理。");
  updateStep(run, "autoTest", "pending", "任务已停止，等待重新执行或人工处理。");
  updateStep(run, "verificationReport", "pending", "任务已停止，等待重新执行或人工处理。");
  updateStep(run, "mergeDaily", "pending", "任务已停止，等待重新执行或人工处理。");
  updateStep(run, "humanReview", "pending", "任务已停止，等待重新执行或人工处理。");
  updateStep(run, "releaseClose", "blocked", "任务停止后暂不发布关闭。");
  appendRunLog(run, `[stop] ${message}`);
}

function findStep(run, stepId) {
  return run.steps.find((step) => step.id === stepId);
}

function updateStep(run, stepId, status, message) {
  const step = findStep(run, stepId);
  if (!step) return;
  step.status = status;
  step.message = message;
}

function appendRunLog(run, value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  for (const line of lines) {
    run.logs.push(line);
  }

  if (run.logs.length > 500) {
    run.logs = run.logs.slice(-500);
  }

  persistWorkflowState().catch((error) => {
    console.warn(`Failed to persist run logs: ${error.message}`);
  });
}

function parseReviewOutput(output) {
  const text = String(output || "");
  const block = text.match(/REVIEW_RESULT([\s\S]*?)END_REVIEW_RESULT/i)?.[1] || text;
  const status = block.match(/status\s*[:：]\s*(pass|changes_requested)/i)?.[1]?.toLowerCase();
  const summary = block.match(/summary\s*[:：]\s*(.+)/i)?.[1]?.trim() || "Review 已完成。";
  const commentsBlock = block.match(/comments\s*[:：]([\s\S]*)/i)?.[1] || "";
  const comments = commentsBlock
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line && !/^无$/.test(line) && !/^END_REVIEW_RESULT$/i.test(line))
    .slice(0, 20);

  if (status === "pass") {
    return { passed: true, summary, comments: [] };
  }

  if (status === "changes_requested") {
    return { passed: false, summary, comments: comments.length ? comments : [summary] };
  }

  if (/REVIEW_PASS|status\s*[:：]\s*通过|无阻塞问题|没有阻塞问题|未发现阻塞/i.test(text)) {
    return { passed: true, summary, comments: [] };
  }

  return {
    passed: false,
    summary: "Review 输出未包含可解析的通过标记，按需修改处理。",
    comments: [trimReviewOutput(text)]
  };
}

function trimReviewOutput(value) {
  const text = String(value || "").trim();
  if (text.length <= 4000) return text;
  return `${text.slice(0, 3800)}\n...（已截断）`;
}

function formatObjectForTask(value) {
  return JSON.stringify(value, null, 2);
}

function runCommand(command, args, options = {}) {
  if (closing) return Promise.reject(new Error("服务正在关闭"));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}: ${stderr || stdout}`));
      }
    });
  });
}

async function commandSucceeds(command, args, options = {}) {
  try {
    await runCommand(command, args, options);
    return true;
  } catch {
    return false;
  }
}

function buildBugBranchName(code) {
  return `codex/${tenant.id}/bug/${safeGitBranchPart(code || "bug")}`;
}

function buildDailyBranchName(run, bug) {
  const owner = resolveDailyBranchOwner(bug);
  return `codex/${tenant.id}/daily/${safeGitBranchPart(owner.key)}/${formatBranchDate(new Date())}`;
}

function resolveDailyBranchOwner(bug) {
  const recommendedAssigneeId = normalizePersonIdentifier(bug?.assignmentRecommendation?.assigneeId);
  const recommendedAssigneeName = normalizePersonIdentifier(bug?.assignmentRecommendation?.assigneeName);
  const bugAssigneeId = normalizePersonIdentifier(bug?.assigneeId);
  const bugAssigneeName = normalizePersonIdentifier(bug?.assignee);
  const configuredAssignee = normalizePersonIdentifier(state.config.assignee);
  const userName = normalizePersonIdentifier(environment.USER);
  const key = recommendedAssigneeId || bugAssigneeId || recommendedAssigneeName || bugAssigneeName || configuredAssignee || userName || "user";

  return {
    key,
    assigneeId: recommendedAssigneeId || bugAssigneeId || "",
    assigneeName: recommendedAssigneeName || bugAssigneeName || ""
  };
}

function normalizePersonIdentifier(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    return String(value.aid || value.employeeId || value.userCode || value.userName || value.name || "").trim();
  }
  return String(value).trim();
}

function resolveIdeExecutor(run) {
  return normalizeIdeExecutor(run?.ideExecutor ?? state.config.ideExecutor);
}

function formatBranchDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function safeGitBranchPart(value) {
  return String(value || "bug")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/[/.]+$/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "bug";
}

async function ensureBugAttachmentsLoaded(bug) {
  if (bug.attachmentsLoaded) return;

  try {
    const attachments = await issueSource().attachments(bug);

    bug.attachments = attachments;
    bug.attachmentsLoaded = true;
    bug.attachmentsError = "";
  } catch (error) {
    bug.attachments = bug.attachments || [];
    bug.attachmentsLoaded = false;
    bug.attachmentsError = sanitizeError(error);
  }
}

async function localizeBugAttachments(bug, workspaceDir) {
  await ensureWorkspaceDir(workspaceDir);
  if (!bug.attachments?.length) return;

  const attachmentsDir = path.join(workspaceDir, ".codex", "attachments", tenant.id, safeFilePart(bug.code || bug.id || bug.aid || "bug"));
  await mkdir(attachmentsDir, { recursive: true });

  for (const [index, attachment] of bug.attachments.entries()) {
    if (attachment.localPath || attachment.localizeError || !attachment.url) continue;

    try {
      const fileName = buildAttachmentFileName(attachment, index);
      const filePath = path.join(attachmentsDir, fileName);
      await downloadAttachment(attachment.url, filePath);
      attachment.localPath = filePath;
      attachment.localRelativePath = path.relative(workspaceDir, filePath);

      if (isArchiveAttachment(attachment, filePath)) {
        const extractDir = path.join(attachmentsDir, `${safeFilePart(path.parse(fileName).name)}-extracted`);
        const extractedFiles = await extractArchive(filePath, extractDir);
        attachment.localExtractedDir = extractDir;
        attachment.localExtractedRelativeDir = path.relative(workspaceDir, extractDir);
        attachment.localExtractedFiles = extractedFiles;
      }
    } catch (error) {
      attachment.localizeError = sanitizeError(error);
      appendRunLogForBug(bug, `[attachment] ${attachment.name || attachment.url} localize failed: ${attachment.localizeError}`);
    }
  }
}

async function downloadAttachment(url, filePath) {
  const source = issueSource();
  if (source.downloadAttachment) {
    await writeFile(filePath, await source.downloadAttachment(url, maxAttachmentDownloadBytes));
    return;
  }
  try {
    await retryDownload(() => downloadAttachmentWithFetch(url, filePath));
  } catch (fetchError) {
    try {
      await retryDownload(() => downloadAttachmentWithCurl(url, filePath));
    } catch (curlError) {
      throw new Error(`fetch 下载失败：${downloadErrorMessage(fetchError)}；curl 下载失败：${downloadErrorMessage(curlError)}`);
    }
  }
}

async function retryDownload(operation, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(attempt * 1000);
      }
    }
  }
  throw lastError;
}

async function downloadAttachmentWithFetch(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载失败 HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxAttachmentDownloadBytes) {
    throw new Error(`附件过大：${contentLength} bytes，超过 ${maxAttachmentDownloadBytes} bytes`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxAttachmentDownloadBytes) {
    throw new Error(`附件过大：${bytes.byteLength} bytes，超过 ${maxAttachmentDownloadBytes} bytes`);
  }

  await writeFile(filePath, bytes);
}

async function downloadAttachmentWithCurl(url, filePath) {
  await runCommand("curl", ["-L", "--fail", "--silent", "--show-error", "--max-time", "60", "--output", filePath, url]);
  const info = await stat(filePath);
  if (info.size > maxAttachmentDownloadBytes) {
    throw new Error(`附件过大：${info.size} bytes，超过 ${maxAttachmentDownloadBytes} bytes`);
  }
}

function downloadErrorMessage(error) {
  const cause = error?.cause?.code || error?.cause?.message;
  return cause ? `${error.message || error} (${cause})` : String(error?.message || error);
}

async function extractArchive(filePath, extractDir) {
  await mkdir(extractDir, { recursive: true });
  const lower = filePath.toLowerCase();

  if (lower.endsWith(".zip")) {
    await assertSafeArchiveEntries("unzip", ["-Z1", filePath]);
    await runCommand("unzip", ["-q", "-o", filePath, "-d", extractDir]);
    return listExtractedFiles(extractDir);
  }

  if (/\.(tar|tar\.gz|tgz)$/.test(lower)) {
    await assertSafeArchiveEntries("tar", ["-tf", filePath]);
    await runCommand("tar", ["-xf", filePath, "-C", extractDir]);
    return listExtractedFiles(extractDir);
  }

  if (lower.endsWith(".gz")) {
    const outputPath = path.join(extractDir, safeFilePart(path.basename(filePath, ".gz")));
    const result = await gunzipAsync(await readFile(filePath));
    await writeFile(outputPath, result);
    return [path.basename(outputPath)];
  }

  return [];
}

async function assertSafeArchiveEntries(command, args) {
  const result = await runCommand(command, args);
  const entries = result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    if (entry.startsWith("/") || entry.includes("..") || path.normalize(entry).startsWith("..")) {
      throw new Error(`压缩包包含不安全路径：${entry}`);
    }
  }
}

async function listExtractedFiles(rootDir, currentDir = rootDir, prefix = "") {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listExtractedFiles(rootDir, absolutePath, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files.slice(0, 100);
}

function buildAttachmentFileName(attachment, index) {
  const parsedName = attachment.name || safeNameFromUrl(attachment.url) || `attachment-${index + 1}`;
  const extension = path.extname(parsedName) || extensionFromUrl(attachment.url);
  const baseName = safeFilePart(path.basename(parsedName, path.extname(parsedName)));
  const safeBaseName = baseName && baseName !== "bug" ? baseName : "attachment";
  return `${String(index + 1).padStart(2, "0")}-${safeBaseName}${extension}`;
}

function safeNameFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
  } catch {
    return "";
  }
}

function extensionFromUrl(url) {
  const name = safeNameFromUrl(url);
  return path.extname(name) || "";
}

function isArchiveAttachment(attachment, filePath) {
  const name = `${attachment.name || ""} ${attachment.url || ""} ${filePath}`.toLowerCase();
  return /\.(zip|tar|tar\.gz|tgz|gz)(\?|#|\s|$)/.test(name);
}

function appendRunLogForBug(bug, message) {
  const run = state.runs.find((item) => item.bugId === bug.id || item.bugCode === bug.code);
  if (run) appendRunLog(run, message);
}

async function saveCodexTask(run, workspaceDir) {
  return saveWorkflowTaskFile(run, "fix", run.taskPacket, workspaceDir);
}

async function applyRunSupplement(run, req) {
  const form = await readSupplementForm(req);
  const text = String(form.fields.text || "").trim();
  const imageFiles = form.files.filter((file) => file.fieldName === "images" && file.data?.length);

  if (!text && !imageFiles.length) {
    appendRunLog(run, "[supplement] no user supplement provided");
    return run;
  }

  if (imageFiles.length > maxSupplementImages) {
    throw new Error(`最多允许上传 ${maxSupplementImages} 张图片。`);
  }

  const workspaceDir = run.codexHandoff?.workspaceDir || resolveWorkspaceDir(state.config.codexWorkspaceDir);
  await ensureWorkspaceDir(workspaceDir);
  const supplementDir = path.join(workspaceDir, ".codex", "supplements", tenant.id, safeFilePart(run.bugCode || run.bugId), safeFilePart(run.id));
  await mkdir(supplementDir, { recursive: true });

  const savedImages = [];
  for (const [index, file] of imageFiles.entries()) {
    if (!String(file.contentType || "").toLowerCase().startsWith("image/")) {
      throw new Error(`补充附件只支持图片：${file.filename || file.fieldName}`);
    }
    if (file.data.length > maxSupplementImageBytes) {
      throw new Error(`图片超过大小限制：${file.filename || file.fieldName}`);
    }

    const fileName = buildSupplementImageFileName(file, index);
    const filePath = path.join(supplementDir, fileName);
    await writeFile(filePath, file.data);
    savedImages.push({
      name: file.filename || fileName,
      contentType: file.contentType || "application/octet-stream",
      size: file.data.length,
      localPath: filePath,
      localRelativePath: path.relative(workspaceDir, filePath),
      savedAt: new Date().toISOString()
    });
  }

  const supplement = {
    text,
    images: savedImages,
    savedAt: new Date().toISOString()
  };

  run.ideSupplement = mergeRunSupplement(run.ideSupplement, supplement);
  run.baseTaskPacket = run.baseTaskPacket || run.taskPacket;
  run.taskPacket = buildTaskPacketWithSupplement(run.baseTaskPacket, run.ideSupplement);
  if (run.codexHandoff) {
    run.codexHandoff = await saveCodexTask(run);
  }

  appendRunLog(run, `[supplement] saved user supplement: text=${text ? "yes" : "no"}, images=${savedImages.length}`);
  return run;
}

function mergeRunSupplement(current, next) {
  const notes = [];
  if (current?.text) notes.push(current.text);
  if (next.text) notes.push(next.text);

  return {
    text: notes.join("\n\n---\n\n").trim(),
    images: [...(current?.images || []), ...(next.images || [])],
    savedAt: next.savedAt
  };
}

function buildTaskPacketWithSupplement(baseTaskPacket, supplement) {
  const section = formatIdeSupplementForTask(supplement);
  return [baseTaskPacket, section].filter(Boolean).join("\n\n");
}

function formatIdeSupplementForTask(supplement) {
  if (!supplement?.text && !supplement?.images?.length) return "";

  const lines = [
    "## 用户补充信息（IDE 执行前）",
    "",
    "下面内容由人工在启动 IDE 任务前补充。复现、定位、修复和验证时需要优先参考这些信息。"
  ];

  if (supplement.savedAt) {
    lines.push(`- 补充时间：${supplement.savedAt}`);
  }

  lines.push("");
  lines.push("### 补充文本");
  lines.push(supplement.text || "无");

  lines.push("");
  lines.push("### 补充图片");
  if (supplement.images?.length) {
    for (const image of supplement.images) {
      lines.push(`- ${image.name || "未命名图片"}`);
      lines.push(`  - 本地文件：${image.localPath}`);
      lines.push(`  - 相对路径：${image.localRelativePath || ""}`);
      lines.push(`  - 类型：${image.contentType || ""}`);
    }
  } else {
    lines.push("无");
  }

  return lines.join("\n");
}

function buildSupplementImageFileName(file, index) {
  const originalName = file.filename || `image-${index + 1}`;
  const originalExt = path.extname(originalName);
  const ext = originalExt || extensionFromContentType(file.contentType) || ".png";
  const base = safeFilePart(path.basename(originalName, originalExt) || `image-${index + 1}`);
  return `${String(index + 1).padStart(2, "0")}-${base}${ext}`;
}

function extensionFromContentType(contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type === "image/jpeg") return ".jpg";
  if (type === "image/png") return ".png";
  if (type === "image/gif") return ".gif";
  if (type === "image/webp") return ".webp";
  if (type === "image/svg+xml") return ".svg";
  return "";
}

async function saveMergeConflictTask(run, { bugBranchName, dailyBranchName, conflict }) {
  const content = [
    `# 合并冲突处理任务`,
    ``,
    `当前 Bug 修复已完成，但将 Bug 分支合并到个人当天验证分支时发生冲突。请在当前仓库中自行解决冲突并完成 merge commit。`,
    ``,
    `## 分支信息`,
    `- Bug 分支：${bugBranchName}`,
    `- 个人当天验证分支：${dailyBranchName}`,
    `- 当前应停留在：${dailyBranchName}`,
    `- 缺陷编码：${run.bugCode}`,
    ``,
    `## 冲突信息`,
    conflict || "未捕获到详细冲突信息。",
    ``,
    `## 处理要求`,
    `1. 不要切换到其他分支。`,
    `2. 阅读冲突文件，保留当天验证分支已有修复，同时合入当前 Bug 分支的必要修改。`,
    `3. 不要删除其他 Bug 已合入日分支的修复。`,
    `4. 解决全部 conflict marker。`,
    `5. 执行必要的 lint/typecheck/unit test/build 或说明无法执行的原因。`,
    `6. 使用 git add 和 git commit 或 git merge --continue 完成合并提交。`,
    `7. 最终回复说明冲突文件、解决策略、测试结果和剩余风险。`
  ].join("\n");

  return saveWorkflowTaskFile(run, "merge-conflict", content);
}

async function runIdeMergeConflictProcess(run, handoff) {
  if (closing) return;
  const executor = resolveIdeExecutor(run);
  return new Promise((resolve, reject) => {
    const child = spawn(getIdeExecutable(executor), buildIdeExecArgs(executor, state.config, handoff.workspaceDir, handoff.taskPath), {
      cwd: handoff.workspaceDir,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true
    });

    run.process = {
      pid: child.pid,
      status: "running",
      phase: "merge-conflict",
      executor,
      startedAt: new Date().toISOString()
    };
    activeProcesses.set(run.id, child);
    appendRunLog(run, `[merge-conflict] ${buildIdeCommand(executor, state.config, handoff.workspaceDir, handoff.taskPath)}`);
    appendRunLog(run, `[merge-conflict] PID ${child.pid || "unknown"}`);

    child.stdout.on("data", (chunk) => appendRunLog(run, chunk.toString()));
    child.stderr.on("data", (chunk) => appendRunLog(run, chunk.toString()));

    child.on("error", (error) => {
      activeProcesses.delete(run.id);
      run.process = {
        ...run.process,
        status: "failed",
        error: sanitizeError(error),
        finishedAt: new Date().toISOString()
      };
      reject(error);
    });

    child.on("close", (code, signal) => {
      activeProcesses.delete(run.id);
      run.process = {
        ...run.process,
        status: run.stopRequested ? "stopped" : "finished",
        exitCode: code,
        signal,
        finishedAt: new Date().toISOString()
      };

      if (run.stopRequested) {
        reject(new Error("合并冲突处理任务已停止。"));
        return;
      }

      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`合并冲突处理任务退出码为 ${code}`));
      }
    });
  });
}

async function saveReviewTask(run, round) {
  const content = [
    `# Codex Review 任务`,
    ``,
    `你是独立 Review 会话。请只审查当前 bug 分支的代码改动，不要修改文件。`,
    ``,
    `## Review 上下文`,
    `- 缺陷编码：${run.bugCode}`,
    `- 当前分支：${run.gitBranch || run.git?.branchName || "未知"}`,
    `- 主分支：${run.git?.baseBranch || state.config.codexBaseBranch || "main"}`,
    `- Review 轮次：${round}/${run.review?.maxRounds || state.config.codexReviewMaxRounds || 3}`,
    ``,
    `## 规范化缺陷信息`,
    formatObjectForTask(run.normalizedBug || {}),
    ``,
    `## 原始修复任务包`,
    run.taskPacket,
    ``,
    `## 审查要求`,
    `- 使用 git diff 审查当前分支相对主分支的改动。`,
    `- 优先指出会导致功能错误、回归、类型/构建失败、测试缺失、安全风险或不符合缺陷目标的问题。`,
    `- 不要因为风格偏好要求修改；只提出必须处理或明显高价值的问题。`,
    `- 如果没有阻塞问题，明确给出通过。`,
    ``,
    `## 输出格式`,
    `最后必须输出下面格式，便于工作台解析：`,
    ``,
    `REVIEW_RESULT`,
    `status: pass 或 changes_requested`,
    `summary: 一句话总结`,
    `comments:`,
    `- 如果 status 是 changes_requested，逐条列出必须修改的问题；如果通过，写“无”。`,
    `END_REVIEW_RESULT`
  ].join("\n");
  return saveWorkflowTaskFile(run, `review-${round}`, content);
}

async function saveReviewFixTask(run, round, reviewResult) {
  const comments = reviewResult.comments.length ? reviewResult.comments.map((comment) => `- ${comment}`).join("\n") : reviewResult.summary;
  const content = [
    `# Codex Review 修改任务`,
    ``,
    `请继续修复同一个 bug。下面是独立 Review 会话给出的修改意见，请只处理这些意见和直接相关问题。`,
    ``,
    `## 缺陷编码`,
    run.bugCode,
    ``,
    `## Review 轮次`,
    `${round}/${run.review?.maxRounds || state.config.codexReviewMaxRounds || 3}`,
    ``,
    `## Review 意见`,
    comments,
    ``,
    `## 原始修复任务包`,
    run.taskPacket,
    ``,
    `## 修改要求`,
    `- 根据 Review 意见做最小必要修改。`,
    `- 如 Review 意见与缺陷目标冲突，保留缺陷目标并在最终回复中说明。`,
    `- 修改后运行相关测试或说明无法运行的原因。`,
    `- 不要改动与 Review 意见无关的文件。`
  ].join("\n");
  return saveWorkflowTaskFile(run, `review-fix-${round}`, content);
}

async function saveWorkflowTaskFile(run, label, content, workspaceDirOverride) {
  const workspaceDir = resolveWorkspaceDir(workspaceDirOverride || state.config.codexWorkspaceDir);
  await ensureWorkspaceDir(workspaceDir);
  const executor = resolveIdeExecutor(run);
  const taskDir = path.join(workspaceDir, ".codex", "tasks", tenant.id);
  const fileName = `${safeFilePart(run.bugCode || run.bugId)}-${run.id}-${safeFilePart(label)}.md`;
  const taskPath = path.join(taskDir, fileName);
  const relativeTaskPath = path.relative(workspaceDir, taskPath);
  const command = buildIdeCommand(executor, state.config, workspaceDir, taskPath);

  await mkdir(taskDir, { recursive: true });
  await writeFile(taskPath, `${content}\n`, "utf8");

  return {
    workspaceDir,
    taskPath,
    relativeTaskPath,
    command,
    executor,
    createdAt: new Date().toISOString()
  };
}

function isIdeTaskHandoffAvailable(handoff) {
  return Boolean(handoff?.workspaceDir && handoff.taskPath && existsSync(handoff.taskPath));
}

async function ensureWorkspaceDir(workspaceDir) {
  if (!state.config.codexWorkspaceDir) throw new Error("请管理员在租户凭据文件中配置独立的 CODEX_WORKSPACE_DIR");
  if (path.resolve(workspaceDir) !== path.resolve(state.config.codexWorkspaceDir)) throw new Error("流水线工作目录与当前租户配置不一致，请重新生成流水线");
  validateWorkspace(workspaceDir);
  try {
    const info = await stat(workspaceDir);
    if (info.isDirectory()) return;
  } catch {
    // Handled by the unified error below.
  }

  throw new Error(`IDE 执行路径不存在或不是目录：${workspaceDir}`);
}

function updateConfig(body) {
  const next = body || {};

  state.config = {
    ...state.config,
    mode,
    ...issueSourceConfig({ environment, config: state.config }, next),
    assignee: stringConfig(next, "assignee", state.config.assignee),
    operatorId: stringConfig(next, "operatorId", state.config.operatorId),
    selfOnly: booleanConfig(next, "selfOnly", state.config.selfOnly),
    intervalMinutes: numberConfig(next, "intervalMinutes", 1, 240, state.config.intervalMinutes),
    ideExecutor: normalizeIdeExecutor(stringConfig(next, "ideExecutor", state.config.ideExecutor)),
    codexWorkspaceDir: stringConfig(next, "codexWorkspaceDir", state.config.codexWorkspaceDir) ? resolveWorkspaceDir(stringConfig(next, "codexWorkspaceDir", state.config.codexWorkspaceDir)) : "",
    codexModel: normalizeCodexModel(stringConfig(next, "codexModel", state.config.codexModel)),
    claudeModel: normalizeClaudeModel(stringConfig(next, "claudeModel", state.config.claudeModel)),
    codexReasoningEffort: normalizeReasoningEffort(stringConfig(next, "codexReasoningEffort", state.config.codexReasoningEffort)),
    codexBaseBranch: normalizeGitRef(stringConfig(next, "codexBaseBranch", state.config.codexBaseBranch), state.config.codexBaseBranch || "main"),
    codexReviewMaxRounds: numberConfig(next, "codexReviewMaxRounds", 1, 10, state.config.codexReviewMaxRounds),
    enableBugInfoCompletion: booleanConfig(next, "enableBugInfoCompletion", state.config.enableBugInfoCompletion),
    allowSkipInfoCompletion: booleanConfig(next, "allowSkipInfoCompletion", state.config.allowSkipInfoCompletion),
    enableAIRouting: booleanConfig(next, "enableAIRouting", state.config.enableAIRouting),
    enableAIAssignment: booleanConfig(next, "enableAIAssignment", state.config.enableAIAssignment),
    enableAutoAssignment: booleanConfig(next, "enableAutoAssignment", state.config.enableAutoAssignment),
    aiAssignmentModel: normalizeCodexModel(stringConfig(next, "aiAssignmentModel", state.config.aiAssignmentModel)),
    aiRoutingModel: normalizeCodexModel(stringConfig(next, "aiRoutingModel", state.config.aiRoutingModel)),
    aiRoutingBaseUrl: normalizeUrl(stringConfig(next, "aiRoutingBaseUrl", state.config.aiRoutingBaseUrl), "https://api.openai.com/v1"),
    aiRoutingTimeoutMs: numberConfig(next, "aiRoutingTimeoutMs", 5000, 120000, state.config.aiRoutingTimeoutMs),
    allowedAutoFixPriorities: priorityConfig(next, "allowedAutoFixPriorities", state.config.allowedAutoFixPriorities),
    requireVerificationReport: booleanConfig(next, "requireVerificationReport", state.config.requireVerificationReport),
    requireRegressionTest: booleanConfig(next, "requireRegressionTest", state.config.requireRegressionTest),
    requireHumanReview: booleanConfig(next, "requireHumanReview", state.config.requireHumanReview),
    enableOperationLogUpload: booleanConfig(next, "enableOperationLogUpload", state.config.enableOperationLogUpload),
    operationLogBaseUrl: normalizeUrl(stringConfig(next, "operationLogBaseUrl", state.config.operationLogBaseUrl), "https://logs.example.com"),
    operationLogEndpoint: stringConfig(next, "operationLogEndpoint", state.config.operationLogEndpoint || DEFAULT_OPERATION_LOG_ENDPOINT) || DEFAULT_OPERATION_LOG_ENDPOINT,
    operationLogChatSource: stringConfig(next, "operationLogChatSource", state.config.operationLogChatSource),
    operationLogSourceType: stringConfig(next, "operationLogSourceType", state.config.operationLogSourceType),
    operationLogSessionId: stringConfig(next, "operationLogSessionId", state.config.operationLogSessionId),
    operationLogUserId: stringConfig(next, "operationLogUserId", state.config.operationLogUserId),
    operationLogCreateName: stringConfig(next, "operationLogCreateName", state.config.operationLogCreateName),
    operationLogDigitalCode: stringConfig(next, "operationLogDigitalCode", state.config.operationLogDigitalCode),
    operationLogAgentName: stringConfig(next, "operationLogAgentName", state.config.operationLogAgentName),
    operationLogAgentVersion: stringConfig(next, "operationLogAgentVersion", state.config.operationLogAgentVersion)
  };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function stringConfig(object, key, fallback) {
  return hasOwn(object, key) ? String(object[key] ?? "").trim() : fallback;
}

function booleanConfig(object, key, fallback) {
  return typeof object[key] === "boolean" ? object[key] : fallback;
}

function numberConfig(object, key, min, max, fallback) {
  return hasOwn(object, key) ? clampNumber(object[key], min, max, fallback) : fallback;
}

function priorityConfig(object, key, fallback) {
  return hasOwn(object, key) ? normalizePriorityList(object[key]) : fallback;
}

async function syncBugs({ incremental = false } = {}) {
  state.scheduler.lastRunStatus = "running";
  state.scheduler.lastRunMessage = "正在同步缺陷";

  try {
    const source = issueSource();
    const startedAt = new Date();
    const bugs = await source.sync({ lastSyncTime: incremental ? state.scheduler.lastSyncTime : null });

    state.bugs = incremental ? mergeBugs(state.bugs, bugs) : bugs;
    startAssignmentRecommendationsForBugs(state.bugs);
    state.scheduler.lastRunMessage = `${issueSource().label} 同步完成，获取 ${bugs.length} 条缺陷；AI 分配建议后台生成中`;

    state.scheduler.lastRunStatus = "success";
    state.scheduler.lastSyncTime = syncCheckpoint(source, startedAt);
    state.scheduler.nextRunAt = nextRunIso();
    recordExecution({
      event: incremental ? "bugs-synced-incremental" : "bugs-synced",
      message: `${issueSource().label} 同步完成，获取 ${bugs.length} 条缺陷（当前本地共 ${state.bugs.length} 条）`,
      status: "success",
      meta: { fetched: bugs.length, total: state.bugs.length, incremental, userKey: state.storageUserKey }
    }, { immediate: true });
    await persistWorkflowState({ immediate: true });

    return { ok: true, ...getBootstrap() };
  } catch (error) {
    state.scheduler.lastRunStatus = "error";
    state.scheduler.lastRunMessage = sanitizeError(error);
    state.scheduler.nextRunAt = nextRunIso();
    return { ok: false, message: state.scheduler.lastRunMessage, ...getBootstrap() };
  }
}

function issueSource() {
  return createIssueSource({ config: state.config, environment });
}

function configureScheduler(enabled) {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }

  if (!enabled) {
    state.scheduler.nextRunAt = null;
    return;
  }

  state.scheduler.nextRunAt = nextRunIso();
  schedulerTimer = setInterval(() => {
    if (mutationPending || hasBackgroundWork()) return;
    mutationPending = true;
    syncBugs({ incremental: true }).catch((error) => {
      state.scheduler.lastRunStatus = "error";
      state.scheduler.lastRunMessage = sanitizeError(error);
    }).finally(() => { mutationPending = false; });
  }, state.config.intervalMinutes * 60 * 1000);
}

function mergeBugs(current, updates) {
  const byId = new Map(current.map((bug) => [bug.id, bug]));
  for (const bug of updates) {
    byId.set(bug.id, { ...byId.get(bug.id), ...bug });
  }
  return sortBugsByUpdatedAt([...byId.values()]);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
      }
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }

      try {
        const parsed = JSON.parse(data);
        if (!parsed || typeof parsed !== "object") throw new Error("请求体必须是 JSON 对象");
        resolve(parsed);
      } catch (error) {
        reject(Object.assign(error, { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

async function readSupplementForm(req) {
  const contentType = String(req.headers["content-type"] || "");
  if (contentType.startsWith("multipart/form-data")) {
    return readMultipartForm(req, contentType, maxSupplementUploadBytes);
  }

  const body = await readJson(req);
  return {
    fields: {
      text: body.text || ""
    },
    files: []
  };
}

async function readMultipartForm(req, contentType, limitBytes) {
  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) throw new Error("缺少 multipart boundary。");

  const body = await readRequestBuffer(req, limitBytes);
  const boundaryText = `--${boundary}`;
  const rawParts = body.toString("binary").split(boundaryText);
  const fields = {};
  const files = [];

  for (let part of rawParts) {
    if (!part || part === "--" || part === "--\r\n") continue;
    if (part.startsWith("\r\n")) part = part.slice(2);
    if (part.endsWith("--\r\n")) part = part.slice(0, -4);
    if (part.endsWith("--")) part = part.slice(0, -2);
    if (part.endsWith("\r\n")) part = part.slice(0, -2);

    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;

    const headerText = part.slice(0, headerEnd);
    const contentBinary = part.slice(headerEnd + 4);
    const headers = parseMultipartHeaders(headerText);
    const disposition = parseContentDisposition(headers["content-disposition"]);
    const fieldName = disposition.name || "";
    if (!fieldName) continue;

    const data = Buffer.from(contentBinary, "binary");
    if (disposition.filename != null) {
      files.push({
        fieldName,
        filename: disposition.filename,
        contentType: headers["content-type"] || "application/octet-stream",
        data
      });
    } else {
      fields[fieldName] = data.toString("utf8");
    }
  }

  return { fields, files };
}

function readRequestBuffer(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipartBoundary(contentType) {
  const match = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match ? (match[1] || match[2] || "").trim() : "";
}

function parseMultipartHeaders(headerText) {
  const headers = {};
  for (const line of String(headerText || "").split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

function parseContentDisposition(value) {
  const result = {};
  for (const part of String(value || "").split(";")) {
    const [rawKey, ...rawRest] = part.split("=");
    const key = rawKey.trim().toLowerCase();
    if (!key || !rawRest.length) continue;
    let itemValue = rawRest.join("=").trim();
    if (itemValue.startsWith("\"") && itemValue.endsWith("\"")) {
      itemValue = itemValue.slice(1, -1);
    }
    result[key] = itemValue;
  }
  return result;
}

function sendJson(res, status, data) {
  if (!closing && status >= 200 && status < 300) workflowStore.scheduleSave(state.storageUserKey, buildUserSnapshot(state));
  sendText(res, status, JSON.stringify(data), "application/json; charset=utf-8");
}

function sendText(res, status, content, type) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(content);
}

function mimeType(filePath) {
  const ext = path.extname(filePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml"
  };
  return types[ext] || "application/octet-stream";
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function parseBooleanConfig(persistedValue, envValue, fallback) {
  if (typeof persistedValue === "boolean") return persistedValue;
  if (typeof envValue === "string") {
    return /^(true|1|yes|on)$/i.test(envValue.trim());
  }
  return fallback;
}

function normalizePriorityList(value) {
  const items = Array.isArray(value) ? value : String(value || "P2,P3").split(/[,，\s]+/);
  const priorities = items
    .map((item) => String(item).trim().toUpperCase())
    .filter((item) => ["P0", "P1", "P2", "P3"].includes(item));
  return priorities.length ? [...new Set(priorities)] : ["P2", "P3"];
}

function resolveWorkspaceDir(value) {
  const raw = String(value || "").trim();
  if (!raw) return __dirname;
  return path.resolve(__dirname, raw);
}

function normalizeUrl(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    return url.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

function normalizeGitRef(value, fallback = "main") {
  const raw = String(value || "").trim();
  const safeFallback = String(fallback || "main").trim() || "main";
  if (!raw) return safeFallback;
  if (raw.startsWith("-") || raw.endsWith("/") || raw.endsWith(".")) return safeFallback;
  if (raw.includes("..") || raw.includes("@{") || raw.includes("\\")) return safeFallback;
  if (!/^[a-zA-Z0-9._/-]+$/.test(raw)) return safeFallback;
  return raw;
}

function sortBugsByUpdatedAt(bugs) {
  return [...bugs].sort((left, right) => Date.parse(right.updatedAt.replace(" ", "T")) - Date.parse(left.updatedAt.replace(" ", "T")));
}

function nextRunIso() {
  return new Date(Date.now() + state.config.intervalMinutes * 60 * 1000).toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function sanitizeError(error) {
  let message = String(error.message || error);
  for (const key of Object.keys(environment).filter((key) => /KEY|SECRET|TOKEN|COOKIE/.test(key))) {
    if (environment[key]) message = message.split(environment[key]).join("[redacted]");
  }
  return message;
}

function safeFilePart(value) {
  return String(value || "bug")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "bug";
}

function hasBackgroundWork() {
  return assignmentJobsPending > 0 || Boolean(assignmentBatchPromise) || activeAssignmentBugIds.size > 0
    || activeProcesses.size > 0 || activeVerificationProcesses.size > 0 || activeReviewProcesses.size > 0 || activeReviewLoops.size > 0;
}

const agentHistory = createAgentHistory({ environment, tenantId: tenant.id, rootDir, workspace: () => state.config.codexWorkspaceDir });
const sessionDelivery = createSessionDelivery({ history: agentHistory, environment });
const taskCenter = createTaskCenter({ database, tenantId: tenant.id, history: agentHistory });
const codexExecution = createCodexExecution({ database, tenantId: tenant.id, workspace: () => state.config.codexWorkspaceDir, environment });

return {
  workspace: () => state.config.codexWorkspaceDir,
  async handleApi(req, res, url, principal) {
    const historyRead = req.method === "GET" && (url.pathname === "/api/agent-sessions" || url.pathname.startsWith("/api/agent-sessions/") || url.pathname === "/api/sessions" || url.pathname.startsWith("/api/sessions/"));
    const mutation = !historyRead && (req.method !== "GET" || url.pathname !== "/api/bootstrap");
    if (mutation && mutationPending) {
      sendJson(res, 409, { error: "tenant_busy", message: "当前租户正在处理其他请求，请稍后重试" });
      req.resume();
      return;
    }
    if (mutation) mutationPending = true;
    try { await requestIdentity.run(principal, () => handleApi(req, res, url)); }
    catch (error) { error.message = sanitizeError(error); throw error; }
    finally { if (mutation) mutationPending = false; }
  },
  async close() {
    codexExecution.close();
    await persistWorkflowState({ immediate: true });
    closing = true;
    configureScheduler(false);
    assignmentJobSeq += 1;
    for (const processes of [activeProcesses, activeVerificationProcesses, activeReviewProcesses]) {
      for (const child of processes.values()) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
      }
    }
    await persistWorkflowState({ immediate: true });
  }
};
}
