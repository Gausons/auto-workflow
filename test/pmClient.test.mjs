import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAuthHeaders,
  buildDefectPagePayload,
  fetchDefectsFromPm,
  normalizeAttachments,
  normalizePmDefectRecords
} from "../src/pmClient.mjs";

test("buildAuthHeaders uses personal AK/SK headers", () => {
  const headers = buildAuthHeaders({ accessKey: "ak", accessSecret: "sk" });
  assert.equal(headers["X-Access-Key"], "ak");
  assert.equal(headers["X-Access-Secret"], "sk");
  assert.equal(headers["Content-Type"], "application/json");
});

test("buildDefectPagePayload includes line and incremental utime conditions", () => {
  const payload = buildDefectPagePayload({
    lineId: "line-1",
    lastSyncTime: "2026-01-01 00:00:00"
  });

  assert.equal(payload.entityType, "DEFECT");
  assert.equal(payload.selfOnly, false);
  assert.equal(payload.conditions[0].fieldCode, "lineId");
  assert.equal(payload.conditions[1].fieldCode, "utime");
  assert.deepEqual(payload.conditions[1].values, ["2026-01-01 00:00:00"]);
  assert.ok(payload.fetchFields.includes("projectId"));
  assert.ok(payload.fetchFields.includes("teamId"));
  assert.ok(payload.fetchFields.includes("client_env"));
});

test("buildDefectPagePayload includes assignee condition when configured", () => {
  const payload = buildDefectPagePayload({
    lineId: "line-1",
    assignee: "test-5583"
  });

  const assignee = payload.conditions.find((condition) => condition.fieldCode === "assignee");
  assert.equal(assignee.editType, "USER");
  assert.deepEqual(assignee.values, ["test-5583"]);
});

test("normalizePmDefectRecords flattens PM field arrays and sorts by update time", () => {
  const records = normalizePmDefectRecords({
    data: {
      page: {
        records: [
          [
            { fieldCode: "aid", value: "1", title: "1" },
            { fieldCode: "code", value: "BUG-1", title: "BUG-1" },
            { fieldCode: "title", value: "old", title: "旧缺陷" },
            { fieldCode: "utime", value: "2026-01-01 10:00:00" }
          ],
          [
            { fieldCode: "aid", value: "2", title: "2" },
            { fieldCode: "code", value: "BUG-2", title: "BUG-2" },
            { fieldCode: "title", value: "new", title: "新缺陷" },
            { fieldCode: "projectId", value: "project-1" },
            { fieldCode: "teamId", value: "team-1" },
            {
              fieldCode: "client_env",
              value: JSON.stringify({
                device_type: "pc",
                device_model: "MacBook Pro",
                client_type: "yonclaw",
                os: "macOS",
                app_version: "1.0.0",
                channel: "none",
                gateway_ip: "127.0.0.1",
                locale: "zh-CN"
              })
            },
            { fieldCode: "utime", value: "2026-01-02 10:00:00" }
          ]
        ]
      }
    }
  });

  assert.equal(records[0].code, "BUG-2");
  assert.equal(records[0].title, "新缺陷");
  assert.equal(records[0].projectId, "project-1");
  assert.equal(records[0].teamId, "team-1");
  assert.equal(records[0].client_env.device_type, "pc");
  assert.equal(records[0].client_env.client_type, "yonclaw");
  assert.equal(records[0].client_env.gateway_ip, "127.0.0.1");
});

test("normalizeAttachments maps PM attachment response", () => {
  const attachments = normalizeAttachments({
    code: 200,
    data: [
      {
        aid: 3704302,
        name: "20251209164503.png",
        size: 393474,
        url: "https://example.com/file.png",
        thumbnailUrl: "https://example.com/thumb.png",
        ctimeStr: "2025.12.09 16:45:05",
        creator: "test-2817"
      }
    ]
  });

  assert.equal(attachments[0].aid, "3704302");
  assert.equal(attachments[0].name, "20251209164503.png");
  assert.equal(attachments[0].url, "https://example.com/file.png");
});

test("fetchDefectsFromPm fetches multiple pages until records are exhausted", async () => {
  const originalFetch = globalThis.fetch;
  const requestedPages = [];

  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requestedPages.push(body.pageNumber);

    const record = (id) => [
      { fieldCode: "aid", value: id, title: id },
      { fieldCode: "code", value: `BUG-${id}`, title: `BUG-${id}` },
      { fieldCode: "title", value: id, title: `缺陷 ${id}` },
      { fieldCode: "utime", value: `2026-01-0${id} 10:00:00` }
    ];

    const records = body.pageNumber === 1 ? [record("1"), record("2")] : [record("3")];

    return new Response(
      JSON.stringify({
        code: 200,
        data: {
          page: {
            records,
            total: 3
          }
        }
      }),
      { status: 200 }
    );
  };

  try {
    const records = await fetchDefectsFromPm({
      baseUrl: "https://pm.example",
      accessKey: "ak",
      accessSecret: "sk",
      lineId: "line-1",
      pageSize: 2,
      maxPages: 5,
      requestDelayMs: 0
    });

    assert.deepEqual(requestedPages, [1, 2]);
    assert.equal(records.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchDefectsFromPm retries once when PM returns rate limit response", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = async () => {
    attempts += 1;

    if (attempts === 1) {
      return new Response(JSON.stringify({ error_msg: "请求次数超上限，请5秒内请求数量控制在5次以内" }), {
        status: 503
      });
    }

    return new Response(
      JSON.stringify({
        code: 200,
        data: {
          page: {
            records: [],
            total: 0
          }
        }
      }),
      { status: 200 }
    );
  };

  try {
    const records = await fetchDefectsFromPm({
      baseUrl: "https://pm.example",
      accessKey: "ak",
      accessSecret: "sk",
      lineId: "line-1",
      requestDelayMs: 0,
      rateLimitRetryMs: 1
    });

    assert.equal(attempts, 2);
    assert.deepEqual(records, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
