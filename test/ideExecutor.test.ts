// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIdeCommand,
  buildIdeExecArgs,
  getIdeExecutable,
  normalizeClaudeModel,
  normalizeCodexModel,
  normalizeIdeExecutor
} from "../src/ideExecutor.js";

const config = {
  codexModel: "gpt-5.5",
  codexReasoningEffort: "high",
  claudeModel: "claude-sonnet-4-6"
};

test("normalizeIdeExecutor defaults to codex", () => {
  assert.equal(normalizeIdeExecutor(undefined), "codex");
  assert.equal(normalizeIdeExecutor("codex"), "codex");
  assert.equal(normalizeIdeExecutor("claude"), "claude");
  assert.equal(normalizeIdeExecutor("unknown"), "codex");
});

test("buildIdeExecArgs builds codex exec command", () => {
  const args = buildIdeExecArgs("codex", config, "/repo", "/repo/.codex/tasks/task.md");
  assert.deepEqual(args.slice(0, 2), ["exec", "-m"]);
  assert.equal(args[2], "gpt-5.5");
  assert.match(args.join(" "), /--cd/);
  assert.match(args.at(-1), /task\.md/);
});

test("normalizeClaudeModel defaults to claude-opus-4-8", () => {
  assert.equal(normalizeClaudeModel(undefined), "claude-opus-4-8");
});

test("normalizeCodexModel defaults to gpt-5.6-sol", () => {
  assert.equal(normalizeCodexModel(undefined), "gpt-5.6-sol");
});

test("buildIdeExecArgs builds claude headless command", () => {
  const args = buildIdeExecArgs("claude", config, "/repo", "/repo/.codex/tasks/task.md");
  assert.equal(args[0], "--bare");
  assert.equal(args[1], "-p");
  assert.equal(args[3], "--model");
  assert.equal(args[4], "claude-sonnet-4-6");
  assert.equal(args[5], "--permission-mode");
  assert.equal(args[6], "acceptEdits");
});

test("buildIdeCommand uses selected executable", () => {
  assert.match(buildIdeCommand("codex", config, "/repo", "/repo/.codex/tasks/task.md"), /^codex exec/);
  assert.match(buildIdeCommand("claude", config, "/repo", "/repo/.codex/tasks/task.md"), /^claude --bare/);
  assert.equal(getIdeExecutable("claude"), "claude");
});
