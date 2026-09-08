export const DEFAULT_OPERATION_LOG_ENDPOINT = "/apiregister/conversation/logs/batch";

const CHAT_SOURCES = new Set(["yonclaw_client", "yonclaw_cloud", "web"]);
const CHANNELS = new Set(["none", "wechat", "youzone", "web"]);
const SOURCE_TYPES = new Set(["builtin", "tenant", "personal"]);
const STATUSES = new Set(["success", "user_abort", "failure"]);
const MAX_BATCH_SIZE = 100;
const MAX_CONVERSATION_ID_LENGTH = 64;
const MAX_SKILLS = 50;
const MAX_ARTIFACTS = 20;

export function normalizeOperationLogItem(item = {}) {
  const normalized = {
    conversation_id: requiredText(item.conversation_id || item.conversationId, "conversation_id"),
    session_id: requiredText(item.session_id || item.sessionId, "session_id"),
    user_id: requiredText(item.user_id || item.userId, "user_id"),
    create_name: optionalText(item.create_name || item.createName),
    create_time: requiredText(item.create_time || item.createTime, "create_time"),
    chat_source: enumText(item.chat_source || item.chatSource || "yonclaw_client", CHAT_SOURCES, "chat_source"),
    channel: enumText(item.channel || "none", CHANNELS, "channel"),
    device_type: optionalText(item.device_type || item.deviceType),
    client_version: optionalText(item.client_version || item.clientVersion),
    os_type: optionalText(item.os_type || item.osType),
    os_version: optionalText(item.os_version || item.osVersion),
    device_arch: optionalText(item.device_arch || item.deviceArch),
    locale: optionalText(item.locale),
    digital_code: requiredText(item.digital_code || item.digitalCode, "digital_code"),
    agent_name: requiredText(item.agent_name || item.agentName, "agent_name"),
    agent_version: requiredText(item.agent_version || item.agentVersion, "agent_version"),
    source_type: enumText(item.source_type || item.sourceType || "builtin", SOURCE_TYPES, "source_type"),
    builtin_agent_id: optionalText(item.builtin_agent_id || item.builtinAgentId),
    builtin_agent_name: optionalText(item.builtin_agent_name || item.builtinAgentName),
    question: requiredText(item.question, "question"),
    answer_text: requiredText(item.answer_text || item.answerText, "answer_text"),
    status: enumText(item.status || "success", STATUSES, "status"),
    total_duration_ms: nonNegativeInteger(item.total_duration_ms ?? item.totalDurationMs ?? 0, "total_duration_ms"),
    task_start_time: optionalText(item.task_start_time || item.taskStartTime),
    task_end_time: optionalText(item.task_end_time || item.taskEndTime),
    feedback_type1: optionalInteger(item.feedback_type1 ?? item.feedbackType1),
    feedback_type2: optionalInteger(item.feedback_type2 ?? item.feedbackType2),
    comment: optionalText(item.comment),
    score: optionalInteger(item.score),
    score_status: optionalInteger(item.score_status ?? item.scoreStatus),
    score_detail: item.score_detail ?? item.scoreDetail,
    evaluated_at: optionalText(item.evaluated_at || item.evaluatedAt),
    skills: normalizeSkills(item.skills),
    artifacts: normalizeArtifacts(item.artifacts)
  };

  if (normalized.conversation_id.length > MAX_CONVERSATION_ID_LENGTH) {
    throw new Error("conversation_id length must be <= 64.");
  }

  return stripEmptyValues(normalized);
}

export function buildOperationLogBatch(items = []) {
  if (!Array.isArray(items)) {
    throw new Error("operation log items must be an array.");
  }

  if (!items.length) {
    throw new Error("operation log items cannot be empty.");
  }

  const acceptedItems = [];
  const failures = [];
  const seen = new Set();

  for (const item of items) {
    try {
      const normalized = normalizeOperationLogItem(item);
      if (seen.has(normalized.conversation_id)) {
        failures.push({
          conversation_id: normalized.conversation_id,
          code: "DUPLICATE_CONVERSATION_ID",
          message: "批次内 conversation_id 重复，已在端侧去重。"
        });
        continue;
      }

      seen.add(normalized.conversation_id);
      acceptedItems.push(normalized);
    } catch (error) {
      failures.push({
        conversation_id: optionalText(item?.conversation_id || item?.conversationId) || null,
        code: "INVALID_ITEM",
        message: error.message || "运营日志条目非法。"
      });
    }
  }

  if (acceptedItems.length > MAX_BATCH_SIZE) {
    throw new Error(`operation log batch size must be <= ${MAX_BATCH_SIZE}.`);
  }

  return {
    items: acceptedItems,
    failures
  };
}

export async function uploadOperationLogs({
  baseUrl = "https://logs.example.com",
  endpoint = DEFAULT_OPERATION_LOG_ENDPOINT,
  cookie,
  token,
  items,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available for operation log upload.");
  }

  const batch = buildOperationLogBatch(items);
  if (!batch.items.length) {
    return {
      ok: false,
      accepted: 0,
      rejected: batch.failures.length,
      failures: batch.failures,
      payload: null
    };
  }

  const response = await fetchImpl(buildOperationLogUrl(baseUrl, endpoint), {
    method: "POST",
    headers: buildOperationLogHeaders({ cookie, token }),
    body: JSON.stringify({ items: batch.items })
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`operation log upload failed with HTTP ${response.status}: ${payload.msg || payload.message || response.statusText}`);
  }

  if (payload.status !== 1) {
    throw new Error(`operation log upload failed: ${payload.msg || payload.message || payload.code || "unknown error"}`);
  }

  const data = payload.data || {};
  const serverFailures = Array.isArray(data.failures) ? data.failures : [];
  return {
    ok: true,
    accepted: Number(data.accepted || 0),
    rejected: Number(data.rejected || 0) + batch.failures.length,
    failures: [...serverFailures, ...batch.failures],
    payload
  };
}

export function buildOperationLogUrl(baseUrl, endpoint = DEFAULT_OPERATION_LOG_ENDPOINT) {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  const root = String(baseUrl || "").replace(/\/$/, "");
  const suffix = String(endpoint || DEFAULT_OPERATION_LOG_ENDPOINT).startsWith("/")
    ? endpoint
    : `/${endpoint}`;
  return `${root}${suffix}`;
}

function buildOperationLogHeaders({ cookie, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function normalizeSkills(skills) {
  if (!skills) return [];
  if (!Array.isArray(skills)) {
    throw new Error("skills must be an array.");
  }
  if (skills.length > MAX_SKILLS) {
    throw new Error(`skills length must be <= ${MAX_SKILLS}.`);
  }

  return skills.map((skill) => stripEmptyValues({
    skill_id: requiredText(skill.skill_id || skill.skillId, "skill_id"),
    skill_name: requiredText(skill.skill_name || skill.skillName, "skill_name"),
    status: optionalText(skill.status),
    duration_ms: optionalNonNegativeInteger(skill.duration_ms ?? skill.durationMs, "duration_ms"),
    input_summary: skill.input_summary ?? skill.inputSummary,
    output_summary: skill.output_summary ?? skill.outputSummary,
    error_message: optionalText(skill.error_message || skill.errorMessage)
  }));
}

function normalizeArtifacts(artifacts) {
  if (!artifacts) return [];
  if (!Array.isArray(artifacts)) {
    throw new Error("artifacts must be an array.");
  }
  if (artifacts.length > MAX_ARTIFACTS) {
    throw new Error(`artifacts length must be <= ${MAX_ARTIFACTS}.`);
  }

  return artifacts.map((artifact) => stripEmptyValues({
    file_name: requiredText(artifact.file_name || artifact.fileName, "file_name")
  }));
}

function requiredText(value, fieldName) {
  const text = optionalText(value);
  if (!text) throw new Error(`${fieldName} is required.`);
  return text;
}

function optionalText(value) {
  return value == null ? "" : String(value).trim();
}

function enumText(value, allowed, fieldName) {
  const text = requiredText(value, fieldName);
  if (!allowed.has(text)) {
    throw new Error(`${fieldName} is invalid.`);
  }
  return text;
}

function nonNegativeInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${fieldName} must be a non-negative number.`);
  }
  return Math.trunc(number);
}

function optionalNonNegativeInteger(value, fieldName) {
  return value == null || value === "" ? undefined : nonNegativeInteger(value, fieldName);
}

function optionalInteger(value) {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : undefined;
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
