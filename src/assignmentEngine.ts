// Personnel are configured per organization; no built-in employee data.
export const DEFAULT_ASSIGNMENT_PEOPLE: any[] = [];

export const ASSIGNMENT_PEOPLE = DEFAULT_ASSIGNMENT_PEOPLE;

export function normalizeAssignmentPeople(value: any, { fallback = DEFAULT_ASSIGNMENT_PEOPLE }: any = {}) {
  const rawPeople = Array.isArray(value) ? value : value?.people;
  const people: any[] = [];
  const seen = new Set();

  for (const raw of Array.isArray(rawPeople) ? rawPeople : []) {
    const name = String(raw?.name || "").trim();
    const employeeId = String(raw?.employeeId || raw?.id || "").trim();
    const responsibility = String(raw?.responsibility || "").trim();
    if (!name || !employeeId || seen.has(employeeId)) continue;
    seen.add(employeeId);
    people.push({ name, employeeId, responsibility });
  }

  return people.length ? people : fallback.map((person: any) => ({ ...person }));
}

export function fallbackAssignmentPerson(people = DEFAULT_ASSIGNMENT_PEOPLE) {
  const normalizedPeople = normalizeAssignmentPeople(people);
  return normalizedPeople.find((person: any) => /兜底|默认|其他/.test(person.responsibility))
    || normalizedPeople[0];
}

export function buildAssignmentSystemPrompt(people = DEFAULT_ASSIGNMENT_PEOPLE) {
  const fallbackPerson = fallbackAssignmentPerson(people);
  if (!fallbackPerson) throw new Error("请先配置分配人员。");
  return [
    "你是项目 缺陷自动分配助手。只输出 JSON，不要输出 Markdown、解释文字或代码块。",
    "你需要根据 Bug 标题、描述、分类、附件信息和人员职责，判断最应该转交给谁。",
    "只能从给定 people 列表中选择一个人，不能编造人员。",
    `如果没有明确匹配人，选择 ${fallbackPerson.name} ${fallbackPerson.employeeId} 作为兜底。`,
    "优先考虑职责强匹配，不要因为当前经办人是谁而偏置。",
    "强制规则：只要缺陷涉及预览、文件预览、附件预览、会话文件预览、preview，即使标题或描述同时出现 skill/技能/skill模块，也必须优先分配给 people 中职责包含预览能力或会话文件预览的负责人。",
    "强制规则：skill 只负责 skill 模块自身能力；skill 触发的预览链路、文件打开、附件查看、预览无响应、预览失败不归 skill 负责人，归预览能力负责人。",
    "输出字段：assigneeId、assigneeName、confidence、matchedResponsibility、reason。",
    "confidence 只能是 high、medium、low。",
    "reason 要简短说明命中的事实、匹配的职责和不确定性。"
  ].join("\n");
}

export function buildAssignmentUserPayload(bug: any, people = DEFAULT_ASSIGNMENT_PEOPLE) {
  return {
    bug: {
      code: bug.code,
      title: bug.title,
      status: bug.status,
      priority: bug.priority,
      severity: bug.severity,
      assignee: bug.assignee,
      product: bug.product,
      category: bug.category,
      description: bug.description,
      expected: bug.expected,
      actual: bug.actual,
      attachments: (bug.attachments || []).map((attachment: any) => ({
        name: attachment.name,
        url: attachment.url,
        thumbnailUrl: attachment.thumbnailUrl,
        contentType: attachment.contentType || attachment.mimeType || "",
        size: attachment.size
      }))
    },
    people: normalizeAssignmentPeople(people),
    outputSchema: {
      assigneeId: "必须是 people.employeeId 中的一个",
      assigneeName: "必须是 people.name 中的一个",
      confidence: "high | medium | low",
      matchedResponsibility: "string",
      reason: "string"
    }
  };
}

export function applyAssignmentBusinessRules(bug: any, recommendation: any, people = DEFAULT_ASSIGNMENT_PEOPLE) {
  const normalizedPeople = normalizeAssignmentPeople(people);
  const previewOwner = findPreviewOwner(normalizedPeople);
  if (!previewOwner || !isPreviewBug(bug)) return recommendation;

  return {
    ...recommendation,
    assigneeId: previewOwner.employeeId,
    assigneeName: previewOwner.name,
    confidence: "high",
    matchedResponsibility: previewOwner.responsibility || "预览能力、会话文件预览、skill 触发的预览",
    reason: "命中强制分配规则：缺陷涉及预览/文件预览，即使由 skill 触发，也归预览能力负责人。"
  };
}

function findPreviewOwner(people: any) {
  const candidates = people.filter((person: any) => !/不包括[^，。,；;]*预览/.test(person.responsibility));
  return candidates.find((person: any) => /预览能力|会话文件预览/.test(person.responsibility))
    || candidates.find((person: any) => /文件预览|附件预览/.test(person.responsibility));
}

function isPreviewBug(bug: any) {
  const text = [
    bug?.title,
    bug?.description,
    bug?.expected,
    bug?.actual,
    bug?.category,
    bug?.product,
    ...(bug?.attachments || []).map((attachment: any) => `${attachment.name || ""} ${attachment.url || ""}`)
  ].filter(Boolean).join(" ");

  return /预览|文件查看|附件查看|打开文件|查看文件|preview|file\s*preview/i.test(text);
}

export function normalizeAssignmentRecommendation(value: any, { model = "", source = "model", people = DEFAULT_ASSIGNMENT_PEOPLE }: any = {}) {
  const normalizedPeople = normalizeAssignmentPeople(people);
  const assigneeId = String(value?.assigneeId || "").trim();
  const person = normalizedPeople.find((item: any) => item.employeeId === assigneeId)
    || normalizedPeople.find((item: any) => item.name === value?.assigneeName)
    || fallbackAssignmentPerson(normalizedPeople);
  if (!person) throw new Error("请先配置分配人员。");
  const confidence = ["high", "medium", "low"].includes(value?.confidence) ? value.confidence : "low";

  return {
    status: "ready",
    source,
    model,
    assigneeId: person.employeeId,
    assigneeName: person.name,
    confidence,
    matchedResponsibility: String(value?.matchedResponsibility || person.responsibility || "").trim(),
    reason: String(value?.reason || "未给出明确原因，已按职责兜底推荐。").trim(),
    assigned: false,
    assignedAt: null,
    error: "",
    createdAt: new Date().toISOString()
  };
}

export function isAssignmentCandidate(bug: any, isAssignableStatus: (status: any) => boolean = () => true) {
  const recommendation = bug?.assignmentRecommendation;
  return isAssignableStatus(bug?.status)
    && Boolean(recommendation?.assigneeId)
    && !recommendation.assigned
    && ["ready", "assign-failed"].includes(recommendation.status);
}

export function buildAssignmentJsonSchema(people = DEFAULT_ASSIGNMENT_PEOPLE) {
  const normalizedPeople = normalizeAssignmentPeople(people);
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      assigneeId: {
        type: "string",
        enum: normalizedPeople.map((person: any) => person.employeeId)
      },
      assigneeName: {
        type: "string",
        enum: normalizedPeople.map((person: any) => person.name)
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"]
      },
      matchedResponsibility: {
        type: "string"
      },
      reason: {
        type: "string"
      }
    },
    required: ["assigneeId", "assigneeName", "confidence", "matchedResponsibility", "reason"]
  };
}
