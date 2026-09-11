import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ASSIGNMENT_PEOPLE,
  applyAssignmentBusinessRules,
  buildAssignmentJsonSchema,
  buildAssignmentSystemPrompt,
  buildAssignmentUserPayload,
  fallbackAssignmentPerson,
  isAssignmentCandidate,
  normalizeAssignmentPeople,
  normalizeAssignmentRecommendation
} from "../src/assignmentEngine.js";

const people = [
  { name: "张三", employeeId: "1001", responsibility: "负责会话管理" },
  { name: "李四", employeeId: "1002", responsibility: "负责兜底" }
];

test("normalizeAssignmentPeople accepts persisted people and removes invalid duplicates", () => {
  const normalized = normalizeAssignmentPeople({
    people: [
      { name: " 张三 ", employeeId: "1001", responsibility: " 会话 " },
      { name: "重复", employeeId: "1001", responsibility: "忽略" },
      { name: "", employeeId: "1003", responsibility: "忽略" }
    ]
  });

  assert.deepEqual(normalized, [
    { name: "张三", employeeId: "1001", responsibility: "会话" }
  ]);
});

test("assignment prompt and schema use dynamic people", () => {
  const prompt = buildAssignmentSystemPrompt(people);
  const schema = buildAssignmentJsonSchema(people);
  const payload = buildAssignmentUserPayload({ code: "BUG-1", title: "会话异常" }, people);

  assert.match(prompt, /李四 1002/);
  assert.match(prompt, /预览能力负责人/);
  assert.doesNotMatch(prompt, /预览负责人 test-5583/);
  assert.deepEqual(schema.properties.assigneeId.enum, ["1001", "1002"]);
  assert.deepEqual(schema.properties.assigneeName.enum, ["张三", "李四"]);
  assert.deepEqual(payload.people, people);
});

test("assignment user payload keeps attachment metadata as text", () => {
  const payload = buildAssignmentUserPayload({
    code: "BUG-IMG",
    title: "截图里能看到预览错误",
    attachments: [
      { name: "preview.png", url: "https://example.com/preview.png" },
      { name: "log.txt", url: "https://example.com/log.txt" },
      { name: "thumb-only", thumbnailUrl: "https://example.com/thumb.jpeg" }
    ]
  }, people);

  assert.deepEqual(payload.bug.attachments, [
    {
      name: "preview.png",
      url: "https://example.com/preview.png",
      thumbnailUrl: undefined,
      contentType: "",
      size: undefined
    },
    {
      name: "log.txt",
      url: "https://example.com/log.txt",
      thumbnailUrl: undefined,
      contentType: "",
      size: undefined
    },
    {
      name: "thumb-only",
      url: undefined,
      thumbnailUrl: "https://example.com/thumb.jpeg",
      contentType: "",
      size: undefined
    }
  ]);
});

test("preview defects triggered by skill are assigned to configured preview owner", () => {
  const recommendation = applyAssignmentBusinessRules(
    {
      code: "BUG-1",
      title: "【skill】附件预览无响应",
      description: "skill 触发文件预览时失败"
    },
    {
      status: "ready",
      source: "model",
      model: "gpt-5.5",
      assigneeId: "test-5407",
      assigneeName: "技能负责人",
      confidence: "high",
      matchedResponsibility: "skill模块",
      reason: "标题包含 skill"
    },
    [
      { name: "技能负责人", employeeId: "test-5407", responsibility: "skill模块，不包括预览" },
      { name: "预览负责人", employeeId: "test-5583", responsibility: "预览能力" }
    ]
  );

  assert.equal(recommendation.assigneeId, "test-5583");
  assert.equal(recommendation.assigneeName, "预览负责人");
  assert.match(recommendation.reason, /预览/);
});

test("normalizeAssignmentRecommendation falls back to configured fallback person", () => {
  const fallback = fallbackAssignmentPerson(people);
  const recommendation = normalizeAssignmentRecommendation(
    { assigneeId: "9999", assigneeName: "不存在", confidence: "maybe" },
    { people, model: "gpt-5.5" }
  );

  assert.equal(fallback.employeeId, "1002");
  assert.equal(recommendation.assigneeId, "1002");
  assert.equal(recommendation.assigneeName, "李四");
  assert.equal(recommendation.confidence, "low");
});

test("isAssignmentCandidate only accepts actionable unassigned recommendations", () => {
  const isAssignableStatus = (status: any) => ["待处理", "处理中"].includes(status);
  const readyBug: any = {
    status: "待处理",
    assignmentRecommendation: { status: "ready", assigneeId: "1001", assigned: false }
  };

  assert.equal(isAssignmentCandidate(readyBug, isAssignableStatus), true);
  assert.equal(isAssignmentCandidate({
    ...readyBug,
    assignmentRecommendation: { ...readyBug.assignmentRecommendation, status: "assign-failed" }
  }, isAssignableStatus), true);
  assert.equal(isAssignmentCandidate({
    ...readyBug,
    assignmentRecommendation: { ...readyBug.assignmentRecommendation, status: "pending" }
  }, isAssignableStatus), false);
  assert.equal(isAssignmentCandidate({
    ...readyBug,
    assignmentRecommendation: { ...readyBug.assignmentRecommendation, assigned: true }
  }, isAssignableStatus), false);
  assert.equal(isAssignmentCandidate({ ...readyBug, status: "已解决" }, isAssignableStatus), false);
});

test("unconfigured organizations have no built-in personnel or fallback assignee", () => {
  assert.deepEqual(DEFAULT_ASSIGNMENT_PEOPLE, []);
  assert.deepEqual(normalizeAssignmentPeople([]), []);
  assert.equal(fallbackAssignmentPerson(), undefined);
  assert.throws(() => buildAssignmentSystemPrompt(), /请先配置分配人员/);
  assert.throws(() => normalizeAssignmentRecommendation({}), /请先配置分配人员/);
});
