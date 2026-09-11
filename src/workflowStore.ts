import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const MAX_EXECUTION_RECORDS = 500;
const MAX_PERSISTED_RUNS = 200;

export function resolveUserStorageKey(config: any = {}) {
  const assignee = normalizePersonIdentifier(config.assignee);
  const operatorId = normalizePersonIdentifier(config.operatorId);

  if (assignee) return safeStorageKey(assignee);
  if (config.selfOnly && operatorId) return safeStorageKey(operatorId);
  if (config.selfOnly) return "self";
  if (operatorId) return safeStorageKey(operatorId);
  return "default";
}

export function normalizePersonIdentifier(value: any) {
  if (value == null) return "";
  if (typeof value === "object") {
    return String(value.aid || value.employeeId || value.userCode || value.userName || value.name || "").trim();
  }
  return String(value).trim();
}

export function safeStorageKey(value: any) {
  return String(value || "default")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "default";
}

export function createExecutionRecord(input: any = {}) {
  const at = input.at || new Date().toISOString();
  return {
    id: input.id || `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    runId: input.runId || "",
    bugId: input.bugId || "",
    bugCode: input.bugCode || "",
    event: input.event || "unknown",
    message: String(input.message || "").trim(),
    status: input.status || "",
    nodeId: input.nodeId || "",
    at,
    meta: input.meta && typeof input.meta === "object" ? input.meta : {}
  };
}

export function recoverInterruptedRuns(runs: any = []) {
  for (const run of runs) {
    if (!run || typeof run !== "object") continue;

    const wasActive = ["running", "reviewing", "validating", "stopping"].includes(run.status)
      || run.process?.status === "running"
      || run.ide?.process?.status === "running"
      || run.review?.process?.status === "running"
      || run.verification?.process?.status === "running";

    if (!wasActive) continue;

    run.status = "interrupted";
    run.finishedAt = run.finishedAt || new Date().toISOString();
    if (run.process) {
      run.process = { ...run.process, status: "interrupted", finishedAt: run.finishedAt };
    }
    if (run.ide?.process) {
      run.ide.process = { ...run.ide.process, status: "interrupted", finishedAt: run.finishedAt };
    }
    if (run.review?.process) {
      run.review.process = { ...run.review.process, status: "interrupted", finishedAt: run.finishedAt };
    }
    if (run.verification?.process) {
      run.verification.process = { ...run.verification.process, status: "interrupted", finishedAt: run.finishedAt };
    }

    const step = run.steps?.find((item: any) => item.status === "running");
    if (step) {
      step.status = "attention";
      step.message = "服务重启导致执行中断，请重新启动或人工处理。";
    }
  }

  return runs;
}

export function createWorkflowStore(rootDir: any) {
  const usersDir = path.join(rootDir, "users");
  let saveTimer: any = null;
  let pendingSave: any = null;
  let temporaryFileSequence = 0;
  const writeQueues = new Map();

  function getStatePath(userKey: any) {
    return path.join(usersDir, safeStorageKey(userKey), "state.json");
  }

  function readUserState(userKey: any) {
    const filePath = getStatePath(userKey);
    if (!existsSync(filePath)) {
      return {
        version: STORE_VERSION,
        userKey: safeStorageKey(userKey),
        updatedAt: null,
        bugs: [],
        runs: [],
        executionRecords: []
      };
    }

    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      return normalizeStoredState(parsed, userKey);
    } catch (error: any) {
      console.warn(`Failed to read workflow state for ${userKey}: ${error.message}`);
      return {
        version: STORE_VERSION,
        userKey: safeStorageKey(userKey),
        updatedAt: null,
        bugs: [],
        runs: [],
        executionRecords: []
      };
    }
  }

  async function writeUserStateFile(userKey: any, snapshot: any) {
    const normalized = normalizeStoredState(snapshot, userKey);
    const filePath = getStatePath(userKey);
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${temporaryFileSequence += 1}.tmp`;

    try {
      await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      await rename(temporaryPath, filePath);
      return normalized;
    } catch (error: any) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  function writeUserState(userKey: any, snapshot: any) {
    const queueKey = safeStorageKey(userKey);
    const previousWrite = writeQueues.get(queueKey) || Promise.resolve();
    const currentWrite = previousWrite
      .catch(() => {})
      .then(() => writeUserStateFile(queueKey, snapshot));

    writeQueues.set(queueKey, currentWrite);
    currentWrite.finally(() => {
      if (writeQueues.get(queueKey) === currentWrite) {
        writeQueues.delete(queueKey);
      }
    }).catch(() => {});

    return currentWrite;
  }

  function scheduleSave(userKey: any, snapshot: any, delayMs = 400) {
    pendingSave = { userKey, snapshot };
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const next: any = pendingSave;
      pendingSave = null;
      saveTimer = null;
      if (!next) return;
      writeUserState(next.userKey, next.snapshot).catch((error: any) => {
        console.warn(`Failed to persist workflow state for ${next.userKey}: ${error.message}`);
      });
    }, delayMs);
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!pendingSave) return null;
    const next = pendingSave;
    pendingSave = null;
    return writeUserState(next.userKey, next.snapshot);
  }

  function appendExecutionRecord(records: any, record: any) {
    const next = [createExecutionRecord(record), ...(Array.isArray(records) ? records : [])];
    return next.slice(0, MAX_EXECUTION_RECORDS);
  }

  return {
    usersDir,
    getStatePath,
    readUserState,
    writeUserState,
    scheduleSave,
    flushSave,
    appendExecutionRecord
  };
}

export function normalizeStoredState(raw: any, userKey: any) {
  const bugs = Array.isArray(raw?.bugs) ? raw.bugs : [];
  const runs = Array.isArray(raw?.runs) ? raw.runs.slice(0, MAX_PERSISTED_RUNS) : [];
  const executionRecords = Array.isArray(raw?.executionRecords)
    ? raw.executionRecords.slice(0, MAX_EXECUTION_RECORDS)
    : [];

  return {
    version: STORE_VERSION,
    userKey: safeStorageKey(userKey),
    updatedAt: raw?.updatedAt || new Date().toISOString(),
    bugs,
    runs,
    executionRecords
  };
}

export function buildUserSnapshot(state: any) {
  return {
    bugs: state.bugs,
    runs: state.runs,
    executionRecords: state.executionRecords
  };
}

export async function loadUserStateFile(filePath: any) {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

export function ensureStoreRoot(rootDir: any) {
  const usersDir = path.join(rootDir, "users");
  if (!existsSync(usersDir)) {
    mkdirSync(usersDir, { recursive: true });
  }
  return usersDir;
}
