// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { buildOperationLogBatch, normalizeOperationLogItem, uploadOperationLogs } from "../src/operationLogClient.js";

const item = {
  conversation_id: "conv-1",
  session_id: "sess-1",
  user_id: "user-1",
  create_time: "2026-06-18T10:00:00+08:00",
  chat_source: "yonclaw_cloud",
  channel: "web",
  digital_code: "auto_bug_workflow",
  agent_name: "Auto Bug Workflow",
  agent_version: "0.1.0",
  source_type: "builtin",
  question: "输入摘要",
  answer_text: "输出摘要",
  status: "success",
  total_duration_ms: 1200
};

test("normalizeOperationLogItem keeps input and output fields in API shape", () => {
  const normalized = normalizeOperationLogItem({
    ...item,
    skills: [
      {
        skillId: "bug_fix",
        skillName: "Bug 修复",
        inputSummary: { bugCode: "BUG-1" },
        outputSummary: "已生成验证报告"
      }
    ],
    artifacts: [{ fileName: "report.md" }]
  });

  assert.equal(normalized.conversation_id, "conv-1");
  assert.equal(normalized.question, "输入摘要");
  assert.equal(normalized.answer_text, "输出摘要");
  assert.equal(normalized.skills[0].skill_id, "bug_fix");
  assert.deepEqual(normalized.artifacts, [{ file_name: "report.md" }]);
});

test("buildOperationLogBatch rejects invalid items and de-duplicates conversation IDs", () => {
  const batch = buildOperationLogBatch([
    item,
    { ...item, answer_text: "重复项" },
    { ...item, conversation_id: "conv-2", question: "" }
  ]);

  assert.equal(batch.items.length, 1);
  assert.equal(batch.failures.length, 2);
  assert.equal(batch.failures[0].code, "DUPLICATE_CONVERSATION_ID");
  assert.equal(batch.failures[1].code, "INVALID_ITEM");
});

test("uploadOperationLogs posts normalized batch and merges server failures", async () => {
  const requested = {};
  const result = await uploadOperationLogs({
    baseUrl: "https://vpa.example/apiregister",
    endpoint: "/conversation/logs/batch",
    cookie: "tenantid=t1",
    items: [item, { ...item, answer_text: "重复项" }],
    fetchImpl: async (url, options) => {
      requested.url = url;
      requested.options = options;
      return new Response(JSON.stringify({
        status: 1,
        msg: "成功",
        data: {
          accepted: 1,
          rejected: 0,
          failures: []
        }
      }), { status: 200 });
    }
  });

  assert.equal(requested.url, "https://vpa.example/apiregister/conversation/logs/batch");
  assert.equal(requested.options.headers.Cookie, "tenantid=t1");
  assert.deepEqual(JSON.parse(requested.options.body).items.map((entry) => entry.conversation_id), ["conv-1"]);
  assert.equal(result.accepted, 1);
  assert.equal(result.rejected, 1);
  assert.equal(result.failures[0].code, "DUPLICATE_CONVERSATION_ID");
});
