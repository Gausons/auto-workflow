import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createExecutionRecord,
  createWorkflowStore,
  recoverInterruptedRuns,
  resolveUserStorageKey,
  safeStorageKey
} from "../src/workflowStore.js";

test("resolveUserStorageKey prefers assignee and isolates users", () => {
  assert.equal(resolveUserStorageKey({ assignee: "test-1359" }), "test-1359");
  assert.equal(resolveUserStorageKey({ selfOnly: true, operatorId: "test-9999" }), "test-9999");
  assert.equal(resolveUserStorageKey({ selfOnly: true }), "self");
  assert.equal(resolveUserStorageKey({}), "default");
});

test("safeStorageKey normalizes unsafe characters", () => {
  assert.equal(safeStorageKey("User/Name#1"), "user-name-1");
});

test("recoverInterruptedRuns marks active runs as interrupted", () => {
  const runs = recoverInterruptedRuns([
    {
      id: "run-1",
      status: "running",
      process: { status: "running" },
      steps: [{ id: "analysis", status: "running", message: "running" }]
    },
    {
      id: "run-2",
      status: "ready",
      steps: [{ id: "analysis", status: "ready", message: "ready" }]
    }
  ]);

  assert.equal(runs[0].status, "interrupted");
  assert.equal(runs[0].process.status, "interrupted");
  assert.equal(runs[0].steps[0].status, "attention");
  assert.equal(runs[1].status, "ready");
});

test("workflow store persists and reloads user scoped state", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "workflow-store-"));
  const store = createWorkflowStore(rootDir);
  const userKey = "test-1359";

  try {
    const snapshot: any = {
      bugs: [{ id: "bug-1", code: "BIP-BUG-1", title: "demo" }],
      runs: [{ id: "run-1", bugId: "bug-1", bugCode: "BIP-BUG-1", status: "ready", logs: [] }],
      executionRecords: [createExecutionRecord({ event: "run-created", bugCode: "BIP-BUG-1", message: "created" })]
    };

    await store.writeUserState(userKey, snapshot);
    const loaded = store.readUserState(userKey);

    assert.equal(loaded.bugs.length, 1);
    assert.equal(loaded.runs[0].id, "run-1");
    assert.equal(loaded.executionRecords[0].event, "run-created");

    const file = JSON.parse(await readFile(store.getStatePath(userKey), "utf8"));
    assert.equal(file.userKey, userKey);
    assert.equal(file.bugs[0].code, "BIP-BUG-1");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("workflow store serializes concurrent writes for the same user", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "workflow-store-concurrent-"));
  const store = createWorkflowStore(rootDir);
  const userKey = "test-1359";

  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.writeUserState(userKey, {
      bugs: [{ id: `bug-${index}` }],
      runs: [],
      executionRecords: []
    })));

    const loaded = store.readUserState(userKey);
    assert.equal(loaded.bugs[0].id, "bug-19");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
