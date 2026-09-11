// @ts-nocheck
import { sourceTransitionPlan } from "./issueSources/workflow.ts";
import { DEFAULT_OPERATION_LOG_ENDPOINT } from "./operationLogClient.js";
import { getIdeExecutorLabel, normalizeIdeExecutor } from "./ideExecutor.js";

export function createCodexTaskPacket(bug, config = {}, options = {}) {
  const steps = (bug.reproduceSteps || []).map((step, index) => `${index + 1}. ${step}`).join("\n");
  const attachments = formatAttachments(bug);
  const infoCompletionEnabled = config.enableBugInfoCompletion !== false;
  const normalized = infoCompletionEnabled ? normalizeBugInfo(bug, config) : null;
  const route = options.routingOverride || classifyBugRoute(bug, normalized || normalizeBugInfo(bug, config), config);

  return [
    `# IDE 自主 Bug 修复任务包`,
    ``,
    `请在当前仓库完成这个 Bug 的技术闭环：复现与定位、修复方案、编码修复、自动化测试，并生成验证报告。Loop 会负责流程控制、人工 Review、发布与关闭工单；不要自行判定工单可以关闭。`,
    ``,
    `## Loop 标准化 Bug 工单模板`,
    infoCompletionEnabled ? formatBugInfoTemplate(normalized) : "配置已关闭信息补全，IDE Agent 直接读取原始 Bug 工单。",
    ``,
    `## Loop 路由分类结果`,
    formatRoutingResult(route),
    ``,
    `## 缺陷`,
    `- 编码：${bug.code}`,
    `- AID：${bug.aid || "未知"}`,
    `- 标题：${bug.title}`,
    `- 状态：${bug.status}`,
    `- 优先级：${bug.priority}`,
    `- 严重级别：${bug.severity}`,
    `- 经办人：${bug.assignee || "未指定"}`,
    `- 产品线：${bug.product || config.lineId || "未指定"}`,
    `- 更新时间：${bug.updatedAt || "未知"}`,
    ``,
    `## 描述`,
    bug.description || "无描述",
    ``,
    `## 复现步骤`,
    steps || "1. 查看原平台问题详情并补充复现步骤",
    ``,
    `## 期望结果`,
    bug.expected || "按缺陷验收标准恢复正常。",
    ``,
    `## 实际结果`,
    bug.actual || "详见缺陷描述。",
    ``,
    `## 附件`,
    attachments,
    ``,
    `## 仓库定位提示`,
    bug.repositoryHint || "让 Codex 先搜索缺陷关键词和相关模块。",
    ``,
    `## 原始验证建议`,
    bug.testHint || "按仓库约定运行测试。",
    ``,
    `## IDE 输出要求`,
    `请按以下阶段输出清晰结果，便于 Loop 页面和人工 Review 判断：`,
    `- Bug Analysis Report：问题现象、复现路径、影响模块、可能根因、证据说明、需要修改的文件、风险点。`,
    `- Fix Plan：根因判断、修改范围、修复思路、不修改的内容、兼容性影响、测试计划、风险与回滚方式。`,
    `- Implementation Summary：修改文件列表、修复摘要、新增测试说明、风险说明。`,
    `- Verification Report：Bug 修复结论、根因说明、修复方式、新增测试、自动化测试结果、回归验证范围、剩余风险、是否建议进入 Review。`,
    ``,
    `## 约束`,
    `- 如果缺陷信息缺失，先根据代码和附件做谨慎定位；无法确认的内容写入风险说明，不要臆造业务规则。`,
    `- 先复现或定位失败路径，再做最小修复。`,
    config.requireVerificationReport === false ? `- 建议生成验证报告。` : `- 必须生成验证报告。`,
    config.requireRegressionTest ? `- 必须补充或说明对应回归测试。` : `- 优先补充对应测试；无法补充时说明原因。`,
    `- 不要修改与缺陷无关的文件。`,
    `- 不要绕过原有校验逻辑，不要静默吞掉异常。`,
    `- 不要把 数据源凭据或其他密钥写入代码、日志或提交内容。`,
    `- 提交信息或回写备注中包含缺陷编码 ${bug.code}，便于问题平台与 Git 绑定。`,
    `- 修复完成后 Loop 会把 Bug 分支合并到个人当天验证分支，再等待人工 Review；不要自行关闭工单。`
  ].join("\n");
}

export function normalizeBugInfo(bug, config = {}) {
  const steps = Array.isArray(bug.reproduceSteps) ? bug.reproduceSteps.filter(Boolean) : [];
  const fields = {
    code: valueOrMissing(bug.code),
    aid: valueOrMissing(bug.aid),
    title: valueOrMissing(bug.title),
    status: valueOrMissing(bug.status),
    priority: valueOrMissing(bug.priority),
    severity: valueOrMissing(bug.severity),
    assignee: valueOrMissing(bug.assignee),
    product: valueOrMissing(bug.product || config.lineId),
    module: valueOrMissing(bug.category),
    updatedAt: valueOrMissing(bug.updatedAt),
    environment: valueOrMissing(bug.environment),
    client_env: normalizeClientEnv(bug.client_env || bug.clientEnv || bug.clientEnvironment),
    version: valueOrMissing(bug.version || bug.releaseVersion),
    impactScope: valueOrMissing(bug.impactScope),
    logs: valueOrMissing(bug.logs || bug.errorLog),
    description: valueOrMissing(bug.description),
    reproduceSteps: steps.length ? steps : ["缺失：请结合描述、附件和相关代码补充复现路径"],
    expected: valueOrMissing(bug.expected),
    actual: valueOrMissing(bug.actual),
    acceptanceCriteria: valueOrMissing(bug.acceptanceCriteria || bug.expected),
    repositoryHint: valueOrMissing(bug.repositoryHint),
    testHint: valueOrMissing(bug.testHint),
    attachments: bug.attachments?.length ? bug.attachments.map((attachment) => attachment.name || attachment.url || attachment.aid || "未命名附件") : []
  };

  const missing = [];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      if (!value.length) missing.push(key);
    } else if (key === "client_env") {
      const missingClientEnvFields = missingClientEnvKeys(value);
      if (missingClientEnvFields.length) {
        missing.push(...missingClientEnvFields.map((field) => `client_env.${field}`));
      }
    } else if (String(value).startsWith("缺失：")) {
      missing.push(key);
    }
  }

  return { fields, missing };
}

export function formatBugInfoTemplate(normalized) {
  const fields = normalized.fields;
  return [
    `- 缺陷编码：${fields.code}`,
    `- AID：${fields.aid}`,
    `- 标题：${fields.title}`,
    `- 状态：${fields.status}`,
    `- 优先级 / 严重级别：${fields.priority} / ${fields.severity}`,
    `- 经办人：${fields.assignee}`,
    `- 产品线 / 模块：${fields.product} / ${fields.module}`,
    `- 更新时间：${fields.updatedAt}`,
    `- 环境：${fields.environment}`,
    `- 客户端环境 client_env：`,
    ...formatClientEnvLines(fields.client_env),
    `- 关联版本：${fields.version}`,
    `- 影响范围：${fields.impactScope}`,
    `- 相关日志：${fields.logs}`,
    `- 问题描述：${fields.description}`,
    `- 复现步骤：`,
    ...fields.reproduceSteps.map((step, index) => `  ${index + 1}. ${step}`),
    `- 期望结果：${fields.expected}`,
    `- 实际结果：${fields.actual}`,
    `- 验收标准：${fields.acceptanceCriteria}`,
    `- 代码定位提示：${fields.repositoryHint}`,
    `- 验证建议：${fields.testHint}`,
    `- 附件：${fields.attachments.length ? fields.attachments.join("、") : "缺失：无附件或尚未加载附件"}`,
    `- 缺失字段：${normalized.missing.length ? normalized.missing.join("、") : "无"}`
  ].join("\n");
}

export function normalizeClientEnv(value) {
  const parsed = parseJsonLike(value);
  const source = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  return {
    device_type: valueOrMissing(source.device_type || source.deviceType, "mobile / pc / pad"),
    device_model: valueOrMissing(source.device_model || source.deviceModel, "设备型号"),
    client_type: valueOrMissing(source.client_type || source.clientType, "yonclaw / web / youzone"),
    os: valueOrMissing(source.os || source.OS, "操作系统"),
    app_version: valueOrMissing(source.app_version || source.appVersion || source.version, "客户端版本"),
    channel: valueOrMissing(source.channel, "wechat / youzone / web / none"),
    gateway_ip: valueOrMissing(source.gateway_ip || source.gatewayIp, "网关 IP"),
    locale: valueOrMissing(source.locale || source.lang, "如 zh-CN")
  };
}

function formatClientEnvLines(clientEnv = {}) {
  return [
    `  - device_type：${clientEnv.device_type || ""}`,
    `  - device_model：${clientEnv.device_model || ""}`,
    `  - client_type：${clientEnv.client_type || ""}`,
    `  - os：${clientEnv.os || ""}`,
    `  - app_version：${clientEnv.app_version || ""}`,
    `  - channel：${clientEnv.channel || ""}`,
    `  - gateway_ip：${clientEnv.gateway_ip || ""}`,
    `  - locale：${clientEnv.locale || ""}`
  ];
}

function missingClientEnvKeys(clientEnv = {}) {
  return Object.entries(clientEnv)
    .filter(([, value]) => String(value || "").startsWith("缺失："))
    .map(([key]) => key);
}

export function classifyBugRoute(bug, normalized = normalizeBugInfo(bug), config = {}) {
  if (config.enableAIRouting === false) {
    return {
      enabled: false,
      bugType: "未启用 AI 路由",
      priority: "P2",
      recommendedHandling: "按人工选择进入 IDE 自主修复。",
      ideAutofixAllowed: true,
      needsHumanIntervention: false,
      reason: "配置 enableAIRouting=false。"
    };
  }

  const text = [
    bug.title,
    bug.description,
    bug.category,
    bug.product,
    bug.priority,
    bug.severity,
    normalized.fields?.description,
    normalized.fields?.actual,
    normalized.fields?.logs
  ].filter(Boolean).join(" ").toLowerCase();

  const bugType = inferBugType(text);
  const priority = inferRoutePriority(bug, text);
  const allowed = normalizeAllowedPriorities(config.allowedAutoFixPriorities);
  const ideAutofixAllowed = allowed.includes(priority);
  const needsHumanIntervention = ["P0", "P1"].includes(priority) || /权限|数据|线上|事故|资损|安全|security|permission|prod|production/.test(text);

  return {
    enabled: true,
    bugType,
    priority,
    recommendedHandling: routeRecommendation(priority, ideAutofixAllowed),
    ideAutofixAllowed,
    needsHumanIntervention,
    reason: ideAutofixAllowed
      ? `${priority} 在允许自动修复优先级内。`
      : `${priority} 不在允许自动修复优先级内，建议人工主导。`
  };
}

export function formatRoutingResult(route) {
  return [
    route.source ? `- 分类来源：${route.source}${route.model ? `（${route.model}）` : ""}` : "",
    `- Bug 类型：${route.bugType}`,
    `- 优先级：${route.priority}`,
    `- 推荐处理方式：${route.recommendedHandling}`,
    `- 是否适合 IDE 自主修复：${route.ideAutofixAllowed ? "是" : "否"}`,
    `- 是否需要人工介入：${route.needsHumanIntervention ? "是" : "否"}`,
    `- 原因：${route.reason}`
  ].filter(Boolean).join("\n");
}

export function runFixWorkflow(bug, config = {}, options = {}) {
  const now = new Date();
  const runId = `run-${now.getTime()}`;
  const infoCompletionEnabled = config.enableBugInfoCompletion !== false;
  const normalizedBug = infoCompletionEnabled ? normalizeBugInfo(bug, config) : null;
  const routing = options.routingOverride || classifyBugRoute(bug, normalizedBug || normalizeBugInfo(bug, config), config);
  const packet = createCodexTaskPacket(bug, config, { routingOverride: routing });
  const executionMode = options.executionMode === "auto" ? "auto" : "manual";
  const ideExecutor = normalizeIdeExecutor(options.ideExecutor ?? config.ideExecutor);
  const auto = executionMode === "auto";
  const autoStart = auto && options.startExecution !== false;
  const ideReady = routing.ideAutofixAllowed;

  const steps = [
    {
      id: "pull",
      label: "原始工单",
      status: "done",
      message: `已读取 ${bug.code} 的原始工单信息。`,
      detail: "缺陷基础信息来自已配置的问题数据源，附件会在创建流水线前尽量补齐。"
    },
    {
      id: "infoCompletion",
      label: "信息补全",
      status: !infoCompletionEnabled ? "skipped" : normalizedBug.missing.length ? "attention" : "done",
      message: !infoCompletionEnabled
        ? "配置已关闭信息补全，原始工单直接进入路由分类。"
        : normalizedBug.missing.length
        ? `缺陷信息已按模板整理，缺失字段：${normalizedBug.missing.join("、")}。`
        : "缺陷信息已按模板整理，关键字段完整。",
      detail: "Loop 调用 AI/规则把问题字段整理成标准 Bug 模板，缺失字段只提示，不强制补齐。"
    },
    {
      id: "routing",
      label: "路由分类",
      status: routing.ideAutofixAllowed ? "done" : "attention",
      message: `${routing.bugType} · ${routing.priority} · ${routing.ideAutofixAllowed ? "允许进入 IDE 自主修复" : "建议人工主导"}`,
      detail: "Loop 对 Bug 分类分级，决定是否适合进入 IDE 自主修复。"
    },
    {
      id: "analysis",
      label: "复现与定位",
      status: autoStart ? "running" : ideReady ? "ready" : "blocked",
      message: autoStart
        ? "IDE Agent 正在复现、搜索代码并定位根因。"
        : ideReady ? "等待启动 IDE 自主执行。" : "路由分类不建议自动修复，需人工判断后处理。",
      detail: "IDE Agent 阅读工单、搜索相关代码、分析日志、尝试复现并输出 Bug Analysis Report。"
    },
    {
      id: "fixPlan",
      label: "生成修复方案",
      status: "pending",
      message: "等待复现与定位完成后生成 Fix Plan。",
      detail: "IDE Agent 输出根因判断、修改范围、修复思路、测试计划、风险和回滚方式。"
    },
    {
      id: "codeFix",
      label: "编码修复",
      status: "pending",
      message: "等待修复方案确认后编码实现。",
      detail: "IDE Agent 进行最小必要修改，只修当前 Bug，必要时补充测试。"
    },
    {
      id: "autoTest",
      label: "自动化测试",
      status: "pending",
      message: "等待编码完成后执行自动化测试。",
      detail: "IDE Agent 执行 lint、typecheck、unit test、build，并按 Bug 类型追加必要测试。"
    },
    {
      id: "verificationReport",
      label: "验证报告",
      status: "pending",
      message: "等待自动化测试完成后生成验证报告。",
      detail: "IDE Agent 证明 Bug 已修复且旧功能未被破坏，输出剩余风险和是否建议进入 Review。"
    },
    {
      id: "mergeDaily",
      label: "合并日分支",
      status: "pending",
      message: "等待 IDE 验证报告后自动合并到个人当天验证分支。",
      detail: "Loop 将 Bug 分支合并到当前团队的个人当天验证分支，用于当天统一验证；合并冲突交给 Codex 处理。"
    },
    {
      id: "humanReview",
      label: "人工 Review",
      status: "pending",
      message: "等待 IDE 验证报告后进入人工 Review。",
      detail: "Loop 组织人工审核根因、方案、改动范围、测试覆盖和风险。"
    },
    {
      id: "releaseClose",
      label: "发布关闭",
      status: "pending",
      message: "等待人工 Review 通过后发布并回填关闭工单。",
      detail: "Loop 确认测试、Review、风险和回滚方式后，半自动回填并关闭工单。"
    }
  ];

  const startedAt = now.toISOString();
  const run = {
    id: runId,
    bugId: bug.id,
    bugCode: bug.code,
    executionMode,
    ideExecutor,
    startedAt,
    finishedAt: null,
    status: autoStart ? "running" : "ready",
    baseTaskPacket: packet,
    taskPacket: packet,
    normalizedBug,
    routing,
    patchSummary: buildPatchSummary(bug),
    sourceTransitionPlan: sourceTransitionPlan(bug),
    steps,
    logs: buildLogs(bug, executionMode, ideExecutor),
    validation: {
      passed: false,
      command: "IDE Agent 自动执行仓库验证命令",
      notes: autoStart
        ? "等待 IDE Agent 生成验证报告。"
        : "流水线已生成，等待确认后启动 IDE 自主执行。"
    },
    review: {
      required: config.requireHumanReview !== false,
      passed: false,
      result: "pending",
      notes: "等待 IDE 验证报告后进入人工 Review。"
    },
    ide: {
      process: null,
      reports: {
        analysis: "",
        fixPlan: "",
        implementation: "",
        automatedTests: "",
        verification: "",
        risks: ""
      }
    },
    reviewLoop: {
      maxRounds: clampReviewRounds(config.codexReviewMaxRounds),
      currentRound: 0,
      passed: false,
      rounds: [],
      notes: "保留兼容字段：当前版本以人工 Review 为准。"
    }
  };

  run.operationLog = buildWorkflowOperationLog(bug, config, {
    runId,
    startedAt,
    executionMode,
    routing,
    normalizedBug,
    taskPacket: packet
  });

  return run;
}

export function buildWorkflowOperationLog(bug, config = {}, options = {}) {
  const startedAt = options.startedAt || new Date().toISOString();
  const normalized = options.normalizedBug || normalizeBugInfo(bug, config);
  const clientEnv = normalized.fields?.client_env || normalizeClientEnv(bug.client_env || bug.clientEnv);
  const sourceType = normalizeSourceType(config.operationLogSourceType);
  const chatSource = normalizeChatSource(config.operationLogChatSource);
  const channel = normalizeChannel(config.operationLogChannel || clientEnv.channel);
  const item = {
    conversation_id: safeOperationId(options.runId || bug.id || bug.aid || bug.code || startedAt),
    session_id: stringValue(config.operationLogSessionId || config.operatorId || "auto-workflow"),
    user_id: stringValue(config.operationLogUserId || config.operatorId || bug.assigneeId || "auto-workflow"),
    create_name: stringValue(config.operationLogCreateName || bug.assignee || "Auto Workflow"),
    chat_source: chatSource,
    channel,
    create_time: startedAt,
    task_start_time: startedAt,
    device_type: missingToEmpty(clientEnv.device_type),
    client_version: stringValue(config.operationLogClientVersion || missingToEmpty(clientEnv.app_version) || config.codexModel || "unknown"),
    os_type: missingToEmpty(clientEnv.os),
    locale: missingToEmpty(clientEnv.locale),
    digital_code: stringValue(config.operationLogDigitalCode || "auto_bug_workflow"),
    agent_name: stringValue(config.operationLogAgentName || "Auto Bug Workflow"),
    agent_version: stringValue(config.operationLogAgentVersion || "0.1.0"),
    source_type: sourceType,
    question: truncateUtf8(buildOperationQuestion(bug, normalized, options), 64 * 1024),
    answer_text: truncateUtf8(buildInitialOperationAnswer(options), 512 * 1024),
    status: "success",
    total_duration_ms: 0,
    artifacts: buildOperationArtifacts(bug)
  };

  return {
    endpoint: config.operationLogEndpoint || DEFAULT_OPERATION_LOG_ENDPOINT,
    item: stripEmptyValues(item),
    upload: {
      enabled: config.enableOperationLogUpload === true,
      status: "pending",
      attempts: 0,
      lastResult: null,
      lastError: ""
    }
  };
}

export function updateWorkflowOperationLogOutput(run, { answerText, status, finishedAt = new Date().toISOString() } = {}) {
  if (!run?.operationLog?.item) return run?.operationLog || null;
  const item = run.operationLog.item;
  const start = Date.parse(item.task_start_time || item.create_time || run.startedAt || "");
  const end = Date.parse(finishedAt);
  item.answer_text = truncateUtf8(answerText || item.answer_text || "工作流已结束。", 512 * 1024);
  item.status = normalizeOperationStatus(status || item.status || "success");
  item.task_end_time = finishedAt;
  item.total_duration_ms = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : Number(item.total_duration_ms || 0);
  return run.operationLog;
}

const IDE_REPORT_HEADINGS = [
  { key: "analysis", pattern: /^(?:bug\s+)?analysis(?:\s+report)?$|^根因分析$|^复现与定位$/i },
  { key: "fixPlan", pattern: /^fix\s+plan$|^修复方案$/i },
  { key: "implementation", pattern: /^(?:implementation|code\s+fix)(?:\s+summary)?$|^编码(?:修复)?摘要$|^实现摘要$/i },
  { key: "automatedTests", pattern: /^(?:automated\s+tests?|test\s+results?|testing)(?:\s+report)?$|^自动化测试(?:结果|报告)?$/i },
  { key: "verification", pattern: /^verification(?:\s+report)?$|^验证报告$/i },
  { key: "risks", pattern: /^(?:remaining\s+)?risks?$|^剩余风险$/i }
];

/**
 * Extract the structured sections requested in the IDE task from its terminal output.
 * The last occurrence wins because Codex may print its final answer more than once.
 */
export function extractIdeReports(output, existing = {}) {
  const sections = {};
  const lines = String(output || "").replaceAll("\r\n", "\n").split("\n");
  let activeKey = "";
  let activeLines = [];

  const commitSection = () => {
    if (!activeKey) return;
    const value = trimReportSection(activeLines);
    if (value) sections[activeKey] = value;
    activeKey = "";
    activeLines = [];
  };

  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const normalized = heading[1].replaceAll("`", "").trim();
      const definition = IDE_REPORT_HEADINGS.find((item) => item.pattern.test(normalized));
      commitSection();
      if (definition) activeKey = definition.key;
      continue;
    }

    if (activeKey && /^\[(?:git|review|release|operation-log|ide|manual|verify)\]\s/i.test(line.trim())) {
      commitSection();
      continue;
    }

    if (activeKey) activeLines.push(line);
  }
  commitSection();

  if (!sections.automatedTests && sections.verification) {
    sections.automatedTests = sections.verification;
  }

  if (!sections.risks && sections.verification) {
    const riskLine = sections.verification
      .split("\n")
      .find((line) => /^\s*[-*]?\s*(?:剩余风险|remaining\s+risks?)\s*[:：]/i.test(line));
    if (riskLine) sections.risks = riskLine.replace(/^\s*[-*]?\s*(?:剩余风险|remaining\s+risks?)\s*[:：]\s*/i, "").trim();
  }

  return {
    analysis: "",
    fixPlan: "",
    implementation: "",
    automatedTests: "",
    verification: "",
    risks: "",
    ...existing,
    ...sections
  };
}

export function hydrateWorkflowIdeReports(run) {
  if (!run || !Array.isArray(run.logs)) return run;
  const reports = extractIdeReports(run.logs.join("\n"), run.ide?.reports || {});
  run.ide = { ...(run.ide || {}), reports };
  return run;
}

function trimReportSection(lines) {
  const next = [...lines];
  while (next.length && !next[0].trim()) next.shift();
  while (next.length && !next.at(-1).trim()) next.pop();
  return next.join("\n").trim();
}

function valueOrMissing(value, hint = "未提供") {
  const text = String(value || "").trim();
  return text || `缺失：${hint}`;
}

function parseJsonLike(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function clampReviewRounds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 3;
  return Math.min(10, Math.max(1, Math.trunc(number)));
}

function inferBugType(text) {
  if (/权限|登录|认证|鉴权|permission|auth|login/.test(text)) return "权限问题类 Bug";
  if (/性能|慢|卡顿|timeout|超时|耗时|performance/.test(text)) return "性能问题类 Bug";
  if (/数据|脏数据|缺数|重复|同步|data/.test(text)) return "数据问题类 Bug";
  if (/构建|打包|部署|ci|lint|build|工程|依赖/.test(text)) return "工程链路类 Bug";
  if (/接口|服务|后端|数据库|sql|api|server/.test(text)) return "后端逻辑类 Bug";
  if (/线上|崩溃|宕机|事故|稳定性|crash|production|prod/.test(text)) return "线上稳定性问题";
  return "前端展示类 Bug";
}

function inferRoutePriority(bug, text) {
  const raw = `${bug.priority || ""} ${bug.severity || ""} ${bug.status || ""}`.toLowerCase();
  if (/p0|s1|blocker|critical|严重线上事故|资损|宕机|崩溃|核心链路不可用/.test(`${raw} ${text}`)) return "P0";
  if (/p1|s2|high|严重|核心|主流程|不可用|会话|对话/.test(`${raw} ${text}`)) return "P1";
  if (/p3|s4|low|minor|体验|样式|文案|低风险/.test(`${raw} ${text}`)) return "P3";
  return "P2";
}

function normalizeAllowedPriorities(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim().toUpperCase()).filter((item) => ["P0", "P1", "P2", "P3"].includes(item));
  }

  const text = String(value || "P2,P3");
  const priorities = text.split(/[,，\s]+/).map((item) => item.trim().toUpperCase()).filter(Boolean);
  return priorities.length ? priorities.filter((item) => ["P0", "P1", "P2", "P3"].includes(item)) : ["P2", "P3"];
}

function routeRecommendation(priority, allowed) {
  if (["P0", "P1"].includes(priority)) return "人工主导，AI 辅助分析，不建议直接自动修复。";
  if (allowed && priority === "P2") return "进入 IDE 自主修复，人工 Review 后合并。";
  if (allowed && priority === "P3") return "优先尝试 IDE 自主修复，走轻量人工 Review。";
  return "不建议自动修复，需人工判断处理。";
}

function formatAttachments(bug) {
  if (bug.attachments?.length) {
    return bug.attachments.map((attachment) => {
      const meta = [
        attachment.size ? `${attachment.size} bytes` : "",
        attachment.ctimeStr || "",
        attachment.creator || ""
      ].filter(Boolean).join(" · ");
      const suffix = attachment.url ? `\n  ${attachment.url}` : "";
      const localLines = [
        attachment.localPath ? `  本地文件：${attachment.localPath}` : "",
        attachment.localExtractedDir ? `  解压目录：${attachment.localExtractedDir}` : "",
        attachment.localExtractedFiles?.length ? `  解压文件：${attachment.localExtractedFiles.join("、")}` : "",
        attachment.localizeError ? `  本地化失败：${attachment.localizeError}` : ""
      ].filter(Boolean).join("\n");
      return `- ${attachment.name || "未命名附件"}${meta ? `（${meta}）` : ""}${suffix}${localLines ? `\n${localLines}` : ""}`;
    }).join("\n");
  }

  if (bug.attachmentsError) {
    return `附件获取失败：${bug.attachmentsError}`;
  }

  return "无附件或尚未加载附件。";
}

function buildPatchSummary(bug) {
  return [
    `定位入口：${bug.repositoryHint || "待 Codex 搜索仓库"}`,
    "修复策略：由 IDE Agent 先输出根因分析和 Fix Plan，再做最小必要改动。",
    "验证策略：由 IDE Agent 执行自动化测试并生成 Verification Report。",
    `问题/Git 绑定：提交信息包含 ${bug.code}。`
  ];
}

function buildLogs(bug, executionMode, ideExecutor = "codex") {
  return [
    `[pull] ${bug.code} ${bug.title}`,
    `[loop] 生成标准 Bug 模板并完成路由分类`,
    `[mode] ${executionMode === "auto" ? "自动执行" : "人工执行"}`,
    `[ide-executor] ${getIdeExecutorLabel(ideExecutor)}`,
    `[ide] 等待 IDE Agent 复现定位、生成方案、编码修复和验证报告`,
    "[git] IDE 完成后自动合并到个人当天验证分支",
    "[review] 等待 Loop 人工 Review 后发布关闭"
  ];
}

function buildOperationQuestion(bug, normalized, options) {
  const fields = normalized.fields || {};
  return [
    `缺陷编码：${bug.code || fields.code || ""}`,
    `标题：${bug.title || fields.title || ""}`,
    `优先级：${bug.priority || fields.priority || ""}`,
    `严重级别：${bug.severity || fields.severity || ""}`,
    `问题描述：${bug.description || fields.description || ""}`,
    `期望结果：${bug.expected || fields.expected || ""}`,
    `实际结果：${bug.actual || fields.actual || ""}`,
    `复现步骤：${Array.isArray(bug.reproduceSteps) && bug.reproduceSteps.length ? bug.reproduceSteps.join(" / ") : fields.reproduceSteps?.join(" / ") || ""}`,
    `路由结果：${options.routing?.bugType || ""} ${options.routing?.priority || ""} ${options.routing?.recommendedHandling || ""}`,
    `执行模式：${options.executionMode === "auto" ? "自动执行" : "人工执行"}`
  ].filter((line) => !line.endsWith("：")).join("\n");
}

function buildInitialOperationAnswer(options) {
  return [
    "已生成 IDE 自主 Bug 修复任务包。",
    `执行模式：${options.executionMode === "auto" ? "自动执行" : "人工执行"}`,
    options.routing?.ideAutofixAllowed === false ? "路由结论：建议人工主导。" : "路由结论：允许进入 IDE 自主修复。",
    "最终验证、Review 与关闭结果会在工作流结束时覆盖本运营日志输出。"
  ].join("\n");
}

function buildOperationArtifacts(bug) {
  return (bug.attachments || [])
    .map((attachment) => attachment.name || attachment.localRelativePath || attachment.localPath || "")
    .filter(Boolean)
    .slice(0, 20)
    .map((fileName) => ({ file_name: fileName }));
}

function normalizeChatSource(value) {
  const text = stringValue(value || "yonclaw_cloud");
  return ["yonclaw_client", "yonclaw_cloud", "web"].includes(text) ? text : "yonclaw_cloud";
}

function normalizeChannel(value) {
  const text = stringValue(value || "none");
  if (text.startsWith("缺失：")) return "none";
  return ["none", "wechat", "youzone", "web"].includes(text) ? text : "none";
}

function normalizeSourceType(value) {
  const text = stringValue(value || "builtin");
  return ["builtin", "tenant", "personal"].includes(text) ? text : "builtin";
}

function normalizeOperationStatus(value) {
  const text = stringValue(value || "success");
  return ["success", "user_abort", "failure"].includes(text) ? text : "success";
}

function safeOperationId(value) {
  return stringValue(value || `operation-${Date.now()}`)
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .slice(0, 64) || `operation-${Date.now()}`;
}

function missingToEmpty(value) {
  const text = stringValue(value);
  return text.startsWith("缺失：") ? "" : text;
}

function stringValue(value) {
  return String(value || "").trim();
}

function truncateUtf8(value, maxBytes) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  let bytes = 0;
  let output = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes - Buffer.byteLength("\n...（已截断）", "utf8")) break;
    output += char;
    bytes += size;
  }
  return `${output}\n...（已截断）`;
}

function stripEmptyValues(value) {
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === "" || entry == null) continue;
    if (Array.isArray(entry) && entry.length === 0) continue;
    result[key] = entry;
  }
  return result;
}
