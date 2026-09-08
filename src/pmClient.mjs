const DEFAULT_FETCH_FIELDS = [
  "aid",
  "code",
  "title",
  "status",
  "priority",
  "severityLevel",
  "productId",
  "categoryId",
  "projectId",
  "teamId",
  "microService",
  "client_env",
  "assignee",
  "ctime",
  "utime",
  "reporter",
  "desc"
];

export function buildAuthHeaders({ accessKey, accessSecret, accessToken } = {}) {
  const headers = { "Content-Type": "application/json" };

  if (accessKey && accessSecret) {
    return {
      ...headers,
      "X-Access-Key": accessKey,
      "X-Access-Secret": accessSecret
    };
  }

  if (accessToken) {
    return {
      ...headers,
      Authorization: `Bearer ${accessToken}`
    };
  }

  throw new Error("PM credentials are missing. Configure PM_ACCESS_KEY and PM_ACCESS_SECRET.");
}

export async function diagnosePm({
  baseUrl,
  accessKey,
  accessSecret,
  accessToken,
  lineId,
  selfOnly,
  assignee,
  pageSize
}) {
  const root = (baseUrl || "https://pm.example.com").replace(/\/$/, "");
  const authHeaders = buildAuthHeaders({ accessKey, accessSecret, accessToken });
  const checks = [];

  checks.push(
    await checkHttp("productLines", `${root}/rest/v1/conf/api/bip/oauth/meta/productLines`, {
      method: "GET",
      headers: authHeaders
    })
  );

  checks.push(
    await checkHttp("defectPage", `${root}/tm/oauth/rest/v1/bip/api/base/page`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(
        buildDefectPagePayload({
          lineId,
          selfOnly,
          assignee,
          pageNumber: 1,
          pageSize: Math.min(Number(pageSize) || 30, 5)
        })
      )
    })
  );

  return checks;
}

export function buildDefectPagePayload({
  lineId,
  lastSyncTime,
  selfOnly = false,
  assignee,
  pageNumber = 1,
  pageSize = 30,
  fetchFields = DEFAULT_FETCH_FIELDS
} = {}) {
  if (!lineId) {
    throw new Error("lineId is required for defect page queries.");
  }

  const conditions = [
    {
      fieldCode: "lineId",
      multiLinkFieldCode: null,
      operation: "eq",
      valueType: "STRING",
      editType: "LIST",
      values: [lineId],
      feValue: lineId,
      operationName: "等于",
      conditionLabel: lineId,
      isCurrent: false,
      formVersion: null
    }
  ];

  if (lastSyncTime) {
    conditions.push({
      fieldCode: "utime",
      multiLinkFieldCode: null,
      operation: "gt",
      valueType: "NUMBER",
      editType: "DATETIME",
      values: [lastSyncTime],
      feValue: [lastSyncTime],
      operationName: "大于",
      conditionLabel: lastSyncTime,
      isCurrent: false,
      formVersion: null
    });
  }

  if (assignee) {
    conditions.push({
      fieldCode: "assignee",
      multiLinkFieldCode: null,
      operation: "eq",
      valueType: "STRING",
      editType: "USER",
      values: [assignee],
      feValue: assignee,
      operationName: "等于",
      conditionLabel: assignee,
      isCurrent: false,
      formVersion: null
    });
  }

  return {
    key: null,
    lineId,
    isAsc: false,
    orderBy: "utime",
    orderByList: [{ sort: "utime", order: "desc" }],
    selfOnly,
    pageNumber,
    pageSize,
    entityType: "DEFECT",
    specific: "DEFECT",
    fetchFields,
    conditions,
    conditionGroups: null,
    statusGroup: null
  };
}

export function buildFilterPayload({ pageNumber = 1, pageSize = 30, fetchFields = DEFAULT_FETCH_FIELDS } = {}) {
  return {
    pageNumber,
    pageSize,
    fetchFields
  };
}

export async function fetchDefectsFromPm({
  baseUrl,
  accessKey,
  accessSecret,
  accessToken,
  lineId,
  filterId,
  lastSyncTime,
  selfOnly,
  assignee,
  pageNumber,
  pageSize,
  maxPages = 10,
  requestDelayMs = 1200,
  rateLimitRetryMs = 5200
}) {
  const root = (baseUrl || "https://pm.example.com").replace(/\/$/, "");
  const hasFilter = Boolean(filterId) && !assignee;
  const url = hasFilter
    ? `${root}/tm/oauth/rest/v1/bip/api/base/pageByFilter/${encodeURIComponent(filterId)}`
    : `${root}/tm/oauth/rest/v1/bip/api/base/page`;
  const size = hasFilter ? Math.min(Number(pageSize) || 30, 100) : Math.min(Number(pageSize) || 30, 300);
  const startPage = Number(pageNumber) || 1;
  const pagesToFetch = Math.max(1, Number(maxPages) || 1);
  const records = [];

  for (let offset = 0; offset < pagesToFetch; offset += 1) {
    const currentPage = startPage + offset;
    const body = hasFilter
      ? buildFilterPayload({ pageNumber: currentPage, pageSize: size })
      : buildDefectPagePayload({
          lineId,
          lastSyncTime,
          selfOnly,
          assignee,
          pageNumber: currentPage,
          pageSize: size
        });

    const payload = await postPmJson(url, body, { accessKey, accessSecret, accessToken }, { rateLimitRetryMs });
    const pageRecords = rawRecordsOf(payload);
    records.push(...pageRecords);

    const total = totalOf(payload);
    if (pageRecords.length < size) break;
    if (total && records.length >= total) break;
    await sleep(Number(requestDelayMs) || 0);
  }

  return normalizePmDefectRecords({ records });
}

export async function fetchBugAttachmentsFromPm({
  baseUrl,
  accessKey,
  accessSecret,
  accessToken,
  aid,
  rateLimitRetryMs = 5200
}) {
  if (!aid) {
    throw new Error("bug aid is required for attachment queries.");
  }

  const root = (baseUrl || "https://pm.example.com").replace(/\/$/, "");
  const url = `${root}/tm/oauth/rest/v1/bip/api/base/attachments/${encodeURIComponent(aid)}`;
  const payload = await getPmJson(url, { accessKey, accessSecret, accessToken }, { rateLimitRetryMs });
  return normalizeAttachments(payload);
}

export async function fetchWorkflowOperationsFromPm({
  baseUrl,
  accessKey,
  accessSecret,
  accessToken,
  lineId,
  aid,
  operatorId,
  entityType = "DEFECT",
  rateLimitRetryMs = 5200
}) {
  if (!lineId) throw new Error("lineId is required for workflow operations.");
  if (!aid) throw new Error("bug aid is required for workflow operations.");
  if (!operatorId) throw new Error("operatorId is required for workflow operations.");

  const root = (baseUrl || "https://pm.example.com").replace(/\/$/, "");
  const params = new URLSearchParams({
    lineId,
    aid,
    entityType,
    operatorId
  });
  const payload = await getPmJson(`${root}/tm/oauth/rest/v1/bip/api/workflow/operations?${params}`, { accessKey, accessSecret, accessToken }, { rateLimitRetryMs });
  return Array.isArray(payload?.data) ? payload.data : [];
}

export async function convertWorkflowProcessFromPm({
  baseUrl,
  accessKey,
  accessSecret,
  accessToken,
  lineId,
  aid,
  operatorId,
  operation,
  currentStatus,
  fieldData,
  entityType = "DEFECT",
  rateLimitRetryMs = 5200
}) {
  if (!lineId) throw new Error("lineId is required for workflow conversion.");
  if (!aid) throw new Error("bug aid is required for workflow conversion.");
  if (!operatorId) throw new Error("operatorId is required for workflow conversion.");
  if (!operation) throw new Error("operation is required for workflow conversion.");
  if (!currentStatus) throw new Error("currentStatus is required for workflow conversion.");

  const root = (baseUrl || "https://pm.example.com").replace(/\/$/, "");
  const params = new URLSearchParams({
    lineId,
    entityType,
    operation,
    currentStatus,
    operatorId
  });
  return postPmJson(`${root}/tm/oauth/rest/v1/bip/api/workflow/processConvert?${params}`, {
    aid,
    fieldData: fieldData || {}
  }, { accessKey, accessSecret, accessToken }, { rateLimitRetryMs });
}

export async function moveDefectInPm({
  baseUrl,
  accessKey,
  accessSecret,
  accessToken,
  lineId,
  aid,
  fieldData,
  rateLimitRetryMs = 5200
}) {
  if (!lineId) throw new Error("lineId is required for defect move.");
  if (!aid) throw new Error("bug aid is required for defect move.");
  if (!fieldData?.assignee) throw new Error("assignee is required for defect move.");

  const root = (baseUrl || "https://pm.example.com").replace(/\/$/, "");
  const params = new URLSearchParams({
    lineId,
    aid
  });
  return postPmJson(`${root}/tm/oauth/rest/v1/bip/api/base/move?${params}`, fieldData, { accessKey, accessSecret, accessToken }, { rateLimitRetryMs });
}

export function normalizePmDefectRecords(payload) {
  const rawRecords = rawRecordsOf(payload);

  return rawRecords.map((record, index) => normalizeRecord(record, index)).sort(compareByUpdatedAtDesc);
}

export function normalizeAttachments(payload) {
  const attachments = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : [];

  return attachments.map((attachment) => ({
    aid: String(attachment.aid ?? ""),
    name: attachment.name || attachment.fileName || "未命名附件",
    size: Number(attachment.size || 0),
    url: attachment.url || "",
    thumbnailUrl: attachment.thumbnailUrl || "",
    ctimeStr: attachment.ctimeStr || "",
    creator: attachment.creator || ""
  }));
}

async function getPmJson(url, auth, options = {}) {
  const retryMs = Number(options.rateLimitRetryMs) || 5200;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await tryGetPmJson(url, auth);
    if (!result.rateLimited || attempt === 1) {
      if (result.error) throw result.error;
      return result.payload;
    }

    await sleep(retryMs);
  }
}

async function tryGetPmJson(url, auth) {
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: buildAuthHeaders(auth)
    });
  } catch (error) {
    const cause = error.cause;
    const causeText = cause?.code || cause?.message ? ` (${[cause?.code, cause?.message].filter(Boolean).join(": ")})` : "";
    return { error: new Error(`PM API connection failed: ${error.message}${causeText}`) };
  }

  const text = await response.text();
  const payload = parseJsonMaybe(text);

  if (!response.ok) {
    return {
      error: new Error(`PM attachments query failed with HTTP ${response.status}: ${summarizeResponse(text || response.statusText)}`),
      rateLimited: isRateLimitResponse(response.status, text)
    };
  }

  if (payload.code && ![0, 200].includes(payload.code)) {
    return { error: new Error(payload.msg || `PM attachments query failed with code ${payload.code}.`) };
  }

  return { payload };
}

async function postPmJson(url, body, auth, options = {}) {
  const retryMs = Number(options.rateLimitRetryMs) || 5200;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await tryPostPmJson(url, body, auth);
    if (!result.rateLimited || attempt === 1) {
      if (result.error) throw result.error;
      return result.payload;
    }

    await sleep(retryMs);
  }
}

async function tryPostPmJson(url, body, auth) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: buildAuthHeaders(auth),
      body: JSON.stringify(body)
    });
  } catch (error) {
    const cause = error.cause;
    const causeText = cause?.code || cause?.message ? ` (${[cause?.code, cause?.message].filter(Boolean).join(": ")})` : "";
    return { error: new Error(`PM API connection failed: ${error.message}${causeText}`) };
  }

  const text = await response.text();
  const payload = parseJsonMaybe(text);

  if (!response.ok) {
    return {
      error: new Error(`PM defect query failed with HTTP ${response.status}: ${summarizeResponse(text || response.statusText)}`),
      rateLimited: isRateLimitResponse(response.status, text)
    };
  }

  if (payload.code && ![0, 200].includes(payload.code)) {
    return { error: new Error(payload.msg || `PM defect query failed with code ${payload.code}.`) };
  }

  return { payload };
}

async function checkHttp(name, url, options) {
  try {
    const response = await fetch(url, options);
    const text = await response.text();
    const payload = parseJsonMaybe(text);
    const code = typeof payload === "object" && payload ? payload.code : undefined;
    const msg = typeof payload === "object" && payload ? payload.msg : undefined;

    return {
      name,
      ok: response.ok && (!code || [0, 200].includes(code)),
      status: response.status,
      code,
      message: msg || summarizeResponse(text || response.statusText),
      url
    };
  } catch (error) {
    const cause = error.cause;
    const causeText = cause?.code || cause?.message ? ` (${[cause?.code, cause?.message].filter(Boolean).join(": ")})` : "";
    return {
      name,
      ok: false,
      status: 0,
      message: `${error.message}${causeText}`,
      url
    };
  }
}

function parseJsonMaybe(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function summarizeResponse(text) {
  const normalized = String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, 500) || "empty response body";
}

function isRateLimitResponse(status, text) {
  return status === 503 && /请求次数超上限|请求数量控制|rate limit/i.test(String(text || ""));
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawRecordsOf(payload) {
  return (
    payload?.data?.page?.records ||
    payload?.data?.records ||
    payload?.page?.records ||
    payload?.records ||
    []
  );
}

function totalOf(payload) {
  return Number(payload?.data?.page?.total || payload?.data?.total || payload?.page?.total || payload?.total || 0);
}

function normalizeRecord(record, index) {
  const fields = Array.isArray(record) ? fieldArrayToMap(record) : record || {};

  const aid = valueOf(fields.aid) || valueOf(fields.id) || `pm-${index + 1}`;
  const updatedAt = valueOf(fields.utime) || valueOf(fields.updatedAt) || valueOf(fields.ctime) || "";

  return {
    id: aid,
    aid,
    code: titleOf(fields.code) || valueOf(fields.code) || aid,
    title: titleOf(fields.title) || valueOf(fields.title) || "未命名缺陷",
    status: titleOf(fields.status) || valueOf(fields.status) || "未知",
    priority: titleOf(fields.priority) || valueOf(fields.priority) || "未设置",
    severity: titleOf(fields.severityLevel) || valueOf(fields.severityLevel) || "未设置",
    assignee: titleOf(fields.assignee) || valueOf(fields.assignee) || "",
    assigneeId: valueOf(fields.assignee) || "",
    product: titleOf(fields.productId) || valueOf(fields.productId) || "",
    productId: valueOf(fields.productId) || "",
    category: titleOf(fields.categoryId) || valueOf(fields.categoryId) || "",
    categoryId: valueOf(fields.categoryId) || "",
    projectId: valueOf(fields.projectId) || "",
    teamId: valueOf(fields.teamId) || "",
    microService: valueOf(fields.microService) || "",
    client_env: normalizeClientEnv(valueOf(fields.client_env) || valueOf(fields.clientEnv)),
    clientEnv: normalizeClientEnv(valueOf(fields.client_env) || valueOf(fields.clientEnv)),
    updatedAt,
    createdAt: valueOf(fields.ctime) || "",
    description: titleOf(fields.desc) || valueOf(fields.desc) || "PM 返回记录未包含描述字段。",
    reproduceSteps: ["查看 PM 缺陷详情", "按描述复现问题", "补充自动化验证命令"],
    expected: "按缺陷验收标准恢复正常。",
    actual: "详见 PM 缺陷描述。",
    repositoryHint: "待 Codex 根据缺陷上下文定位",
    testHint: "按仓库测试脚本执行",
    automationState: "ready",
    lastRunId: null
  };
}

function normalizeClientEnv(value) {
  const parsed = parseJsonLike(value);
  const source = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  return {
    device_type: String(source.device_type || source.deviceType || "").trim(),
    device_model: String(source.device_model || source.deviceModel || "").trim(),
    client_type: String(source.client_type || source.clientType || "").trim(),
    os: String(source.os || source.OS || "").trim(),
    app_version: String(source.app_version || source.appVersion || source.version || "").trim(),
    channel: String(source.channel || "").trim(),
    gateway_ip: String(source.gateway_ip || source.gatewayIp || "").trim(),
    locale: String(source.locale || source.lang || "").trim()
  };
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

function fieldArrayToMap(fields) {
  return Object.fromEntries(
    fields
      .filter((field) => field && field.fieldCode)
      .map((field) => [field.fieldCode, field])
  );
}

function valueOf(field) {
  if (field == null) return "";
  if (typeof field === "object") return field.value ?? field.title ?? "";
  return field;
}

function titleOf(field) {
  if (field == null || typeof field !== "object") return "";
  return field.title ?? "";
}

function compareByUpdatedAtDesc(left, right) {
  return dateValue(right.updatedAt) - dateValue(left.updatedAt);
}

function dateValue(value) {
  if (!value) return 0;
  const normalized = String(value).replace(" ", "T");
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
