import assert from "node:assert/strict";
import test from "node:test";
import { classifyBugRoute, createCodexTaskPacket, extractIdeReports, hydrateWorkflowIdeReports, normalizeBugInfo, runFixWorkflow, updateWorkflowOperationLogOutput } from "../src/workflowEngine.mjs";

const bug = {
  id: "bug-1",
  aid: "bug-1",
  code: "KFGL-TM-BUG-1",
  title: "保存配置失败",
  status: "待处理",
  priority: "Medium",
  severity: "S3",
  product: "示例项目",
  description: "保存后刷新丢失。",
  reproduceSteps: ["保存配置", "刷新页面"],
  expected: "配置保留",
  actual: "配置丢失",
  client_env: {
    device_type: "pc",
    device_model: "MacBook Pro",
    client_type: "yonclaw",
    os: "macOS",
    app_version: "1.2.3",
    channel: "none",
    gateway_ip: "127.0.0.1",
    locale: "zh-CN"
  },
  repositoryHint: "server.mjs",
  testHint: "node --test",
  attachments: [
    {
      name: "复现截图.png",
      size: 2048,
      url: "https://example.com/bug.png",
      localPath: "/repo/.codex/attachments/KFGL-TM-BUG-1/01-bug.png",
      localExtractedDir: "/repo/.codex/attachments/KFGL-TM-BUG-1/archive-extracted",
      localExtractedFiles: ["a.txt", "b/c.txt"],
      ctimeStr: "2026.06.08 10:00:00",
      creator: "tester"
    }
  ],
  attachmentsLoaded: true
};

test("createCodexTaskPacket includes defect code and verification command", () => {
  const packet = createCodexTaskPacket(bug);
  assert.match(packet, /KFGL-TM-BUG-1/);
  assert.match(packet, /node --test/);
  assert.match(packet, /Loop 标准化 Bug 工单模板/);
  assert.match(packet, /Loop 路由分类结果/);
  assert.match(packet, /Verification Report/);
  assert.match(packet, /客户端环境 client_env/);
  assert.match(packet, /device_type：pc/);
  assert.match(packet, /gateway_ip：127\.0\.0\.1/);
  assert.match(packet, /复现截图\.png/);
  assert.match(packet, /https:\/\/example\.com\/bug\.png/);
  assert.match(packet, /本地文件：\/repo\/\.codex\/attachments\/KFGL-TM-BUG-1\/01-bug\.png/);
  assert.match(packet, /解压目录：\/repo\/\.codex\/attachments\/KFGL-TM-BUG-1\/archive-extracted/);
  assert.match(packet, /解压文件：a\.txt、b\/c\.txt/);
});

test("normalizeBugInfo includes structured client_env fields", () => {
  const normalized = normalizeBugInfo({
    ...bug,
    client_env: JSON.stringify({
      device_type: "mobile",
      device_model: "iPhone",
      client_type: "yonclaw",
      os: "iOS",
      app_version: "2.0.0",
      channel: "wechat",
      gateway_ip: "10.0.0.1",
      locale: "zh-CN"
    })
  });

  assert.equal(normalized.fields.client_env.device_type, "mobile");
  assert.equal(normalized.fields.client_env.device_model, "iPhone");
  assert.equal(normalized.fields.client_env.client_type, "yonclaw");
  assert.equal(normalized.fields.client_env.channel, "wechat");
  assert.equal(normalized.fields.client_env.gateway_ip, "10.0.0.1");
});

test("normalizeBugInfo returns a stable template with missing fields", () => {
  const normalized = normalizeBugInfo({ ...bug, expected: "", actual: "", reproduceSteps: [] });
  assert.equal(normalized.fields.code, "KFGL-TM-BUG-1");
  assert.ok(normalized.fields.expected.startsWith("缺失"));
  assert.ok(normalized.missing.includes("expected"));
  assert.deepEqual(normalized.fields.reproduceSteps, ["缺失：请结合描述、附件和相关代码补充复现路径"]);
});

test("classifyBugRoute allows P2 defects into IDE autonomous fix", () => {
  const route = classifyBugRoute(bug, normalizeBugInfo(bug), { allowedAutoFixPriorities: ["P2", "P3"] });
  assert.equal(route.priority, "P2");
  assert.equal(route.ideAutofixAllowed, true);
  assert.match(route.recommendedHandling, /IDE 自主修复/);
});

test("classifyBugRoute treats session and conversation defects as P1", () => {
  const sessionBug = {
    ...bug,
    title: "新建会话后对话内容未同步"
  };
  const route = classifyBugRoute(sessionBug, normalizeBugInfo(sessionBug), { allowedAutoFixPriorities: ["P2", "P3"] });
  assert.equal(route.priority, "P1");
  assert.equal(route.ideAutofixAllowed, false);
  assert.match(route.recommendedHandling, /人工主导/);
});

test("runFixWorkflow returns a manual execution pipeline", () => {
  const run = runFixWorkflow(bug, { lineId: "line-1", codexReviewMaxRounds: 4 }, { executionMode: "manual" });
  assert.equal(run.bugCode, "KFGL-TM-BUG-1");
  assert.equal(run.executionMode, "manual");
  assert.equal(run.status, "ready");
  assert.equal(run.validation.command, "IDE Agent 自动执行仓库验证命令");
  assert.equal(run.review.required, true);
  assert.ok(run.steps.length >= 11);
  assert.equal(run.steps.find((step) => step.id === "infoCompletion").status, "attention");
  assert.equal(run.steps.find((step) => step.id === "routing").status, "done");
  assert.equal(run.steps.find((step) => step.id === "analysis").status, "ready");
  assert.equal(run.steps.find((step) => step.id === "mergeDaily").status, "pending");
  assert.equal(run.steps.find((step) => step.id === "humanReview").status, "pending");
  assert.equal(run.steps.find((step) => step.id === "releaseClose").status, "pending");
  assert.equal(run.operationLog.item.conversation_id, run.id);
  assert.equal(run.operationLog.item.chat_source, "yonclaw_cloud");
  assert.match(run.operationLog.item.question, /保存配置失败/);
  assert.match(run.operationLog.item.answer_text, /已生成 IDE 自主 Bug 修复任务包/);
});

test("runFixWorkflow uses injected model routing result", () => {
  const route = {
    enabled: true,
    source: "model",
    model: "gpt-5.5",
    bugType: "后端逻辑类 Bug",
    priority: "P1",
    recommendedHandling: "人工主导，AI 辅助分析，不建议直接自动修复。",
    ideAutofixAllowed: false,
    needsHumanIntervention: true,
    reason: "模型判断会话链路风险较高。"
  };
  const run = runFixWorkflow(bug, { lineId: "line-1" }, { executionMode: "manual", routingOverride: route });
  assert.equal(run.routing.source, "model");
  assert.equal(run.routing.priority, "P1");
  assert.match(run.taskPacket, /分类来源：model（gpt-5\.5）/);
  assert.equal(run.steps.find((step) => step.id === "routing").status, "attention");
  assert.equal(run.steps.find((step) => step.id === "analysis").status, "blocked");
});

test("runFixWorkflow returns an auto execution pipeline", () => {
  const run = runFixWorkflow(bug, { lineId: "line-1" }, { executionMode: "auto" });
  assert.equal(run.executionMode, "auto");
  assert.equal(run.status, "running");
  assert.equal(run.steps.find((step) => step.id === "analysis").status, "running");
});

test("runFixWorkflow can generate an auto pipeline without starting execution", () => {
  const run = runFixWorkflow(bug, { lineId: "line-1" }, { executionMode: "auto", startExecution: false });
  assert.equal(run.executionMode, "auto");
  assert.equal(run.status, "ready");
  assert.equal(run.steps.find((step) => step.id === "analysis").status, "ready");
});

test("runFixWorkflow records selected IDE executor", () => {
  const run = runFixWorkflow(bug, { lineId: "line-1" }, { executionMode: "manual", ideExecutor: "claude" });
  assert.equal(run.ideExecutor, "claude");
  assert.match(run.logs.join("\n"), /Claude Code/);
});

test("extractIdeReports maps IDE markdown sections to pipeline node data", () => {
  const reports = extractIdeReports(`
### Bug Analysis Report
- 根因为错误的状态映射。
### Fix Plan
- 修正映射并补充回归测试。
### Implementation Summary
- 修改 src/state.ts。
### Verification Report
- unit test：12/12 通过。
- 剩余风险：尚未执行真机验证。
[git] merged bug branch
  `);

  assert.match(reports.analysis, /错误的状态映射/);
  assert.match(reports.fixPlan, /补充回归测试/);
  assert.match(reports.implementation, /src\/state\.ts/);
  assert.match(reports.automatedTests, /12\/12 通过/);
  assert.match(reports.verification, /剩余风险/);
  assert.equal(reports.risks, "尚未执行真机验证。");
  assert.doesNotMatch(reports.verification, /merged bug branch/);
});

test("hydrateWorkflowIdeReports backfills reports for persisted runs", () => {
  const run = runFixWorkflow(bug, {}, { executionMode: "manual" });
  run.logs.push(
    "## Fix Plan",
    "- 只修改点击节点的数据映射。",
    "## Implementation Summary",
    "- 已补齐详情渲染。",
    "## Verification Report",
    "- 前端回归通过。"
  );

  hydrateWorkflowIdeReports(run);

  assert.match(run.ide.reports.fixPlan, /数据映射/);
  assert.match(run.ide.reports.implementation, /详情渲染/);
  assert.match(run.ide.reports.automatedTests, /前端回归通过/);
});

test("updateWorkflowOperationLogOutput records final output without process logs", () => {
  const run = runFixWorkflow(bug, { lineId: "line-1" }, { executionMode: "manual" });
  updateWorkflowOperationLogOutput(run, {
    status: "failure",
    answerText: "验证未通过，需要人工复核。",
    finishedAt: "2026-06-18T10:00:01+08:00"
  });

  assert.equal(run.operationLog.item.status, "failure");
  assert.equal(run.operationLog.item.answer_text, "验证未通过，需要人工复核。");
  assert.equal(run.operationLog.item.task_end_time, "2026-06-18T10:00:01+08:00");
  assert.ok(Number.isInteger(run.operationLog.item.total_duration_ms));
});
