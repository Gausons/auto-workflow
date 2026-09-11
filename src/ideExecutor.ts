// @ts-nocheck
const IDE_EXECUTORS = {
  codex: { command: "codex", label: "Codex" },
  claude: { command: "claude", label: "Claude Code" }
};

const DEFAULT_CLAUDE_MODEL = "claude-opus-4-8";
const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

export function normalizeIdeExecutor(value) {
  return value === "claude" ? "claude" : "codex";
}

export function getIdeExecutorLabel(executor) {
  return IDE_EXECUTORS[normalizeIdeExecutor(executor)].label;
}

export function getIdeExecutable(executor) {
  return IDE_EXECUTORS[normalizeIdeExecutor(executor)].command;
}

export function normalizeCodexModel(value) {
  const raw = String(value || "").trim();
  if (!raw) return DEFAULT_CODEX_MODEL;
  if (!/^[a-zA-Z0-9._:-]+$/.test(raw)) return DEFAULT_CODEX_MODEL;
  return raw;
}

export function normalizeClaudeModel(value) {
  const raw = String(value || "").trim();
  if (!raw) return DEFAULT_CLAUDE_MODEL;
  if (!/^[a-zA-Z0-9._:-]+$/.test(raw)) return DEFAULT_CLAUDE_MODEL;
  return raw;
}

export function normalizeReasoningEffort(value) {
  const labelMap = new Map([
    ["低", "low"],
    ["中", "medium"],
    ["高", "high"],
    ["超高", "xhigh"]
  ]);
  const raw = String(value || "").trim();
  const normalized = labelMap.get(raw) || raw.toLowerCase();
  return ["low", "medium", "high", "xhigh"].includes(normalized) ? normalized : "medium";
}

export function buildIdeExecArgs(executor, config = {}, workspaceDir, taskPath) {
  return normalizeIdeExecutor(executor) === "claude"
    ? buildClaudeExecArgs(config, taskPath)
    : buildCodexExecArgs(config, workspaceDir, taskPath);
}

export function buildIdeCommand(executor, config = {}, workspaceDir, taskPath) {
  const executable = getIdeExecutable(executor);
  return [executable, ...buildIdeExecArgs(executor, config, workspaceDir, taskPath).map(shellArg)].join(" ");
}

function buildCodexExecArgs(config, workspaceDir, taskPath) {
  const args = ["exec"];
  const model = normalizeCodexModel(config.codexModel);
  const effort = normalizeReasoningEffort(config.codexReasoningEffort);

  if (model) {
    args.push("-m", model);
  }

  if (effort) {
    args.push("-c", `model_reasoning_effort="${effort}"`);
  }

  args.push("--cd", workspaceDir, `请读取并执行任务文件：${taskPath}`);
  return args;
}

function buildClaudeExecArgs(config, taskPath) {
  const args = [
    "--bare",
    "-p",
    `请读取并执行任务文件：${taskPath}`,
    "--model",
    normalizeClaudeModel(config.claudeModel),
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Read,Edit,Bash,Glob,Grep"
  ];
  return args;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function shellArg(value) {
  const raw = String(value);
  return /^[a-zA-Z0-9._:/=-]+$/.test(raw) ? raw : shellQuote(raw);
}
