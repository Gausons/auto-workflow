import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, appendFile, rm, rename, symlink, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAgentHistory } from '../src/agentHistory/index.js';
import { createSessionDelivery } from '../src/sessionDelivery/index.ts';
import { deliverRecord } from '../src/sessionDelivery/records.ts';
import { createApp } from '../server.js';
import { openDatabase } from '../src/database.js';

const timestamp = '2026-09-09T01:00:00Z';
const message = (text: string) => ({ type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const serialize = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
async function fixture(t: TestContext, scope = 'all') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), records = path.join(root, 'records');
  await mkdir(workspace); await mkdir(records);
  const environment: any = { IDE_HISTORY_CODEX_DIR: records, IDE_HISTORY_CLAUDE_DIR: records, IDE_HISTORY_SCOPE: scope, OPENAI_API_KEY: 'synthetic-private-credential' };
  const history = createAgentHistory({ tenantId: 'test', environment, workspace: () => workspace });
  const service = createSessionDelivery({ history, environment });
  const file = path.join(records, 'session.jsonl');
  const meta: any = { type: 'session_meta', timestamp, payload: { id: 'task-a', cwd: workspace } };
  await writeFile(file, serialize([meta]));
  const id = (await service.list(new URLSearchParams({ agent: 'codex' }))).sessions[0]!.id;
  return { root, records, workspace, file, meta, environment, history, service, id };
}

test('full delivery retains long tool results, structured images and user context removed from preview', async t => {
  const f = await fixture(t);
  const long = 'x'.repeat(40000), instructions = '<environment_context>task constraints</environment_context> Continue this task';
  await appendFile(f.file, serialize([
    message(instructions),
    { type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: 'call-1', output: long } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }] } },
    { type: 'response_item', payload: { type: 'reasoning', text: 'hidden-reasoning' } },
    { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'hidden-event-reasoning' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: 'hidden-analysis' } },
    message('OPENAI_API_KEY=synthetic-private-credential'),
    { type: 'response_item', payload: { type: 'message', role: 'system', content: 'system-record-not-delivered' } }
  ]));
  const result = await f.service.detail(f.id);
  const json = JSON.stringify(result.events);
  assert.ok(json.includes(long)); assert.ok(json.includes(instructions)); assert.ok(json.includes('data:image/png'));
  assert.doesNotMatch(json, /hidden-reasoning|hidden-event-reasoning|hidden-analysis|system-record-not-delivered|synthetic-private-credential/);
  assert.doesNotMatch(JSON.stringify((await f.service.list()).sessions), /synthetic-private-credential/);
  assert.match(json, /redacted/); assert.equal(result.coverage.reachedEnd, true);
  assert.equal(result.nextCursor, null); assert.equal(result.events.filter(e => e.kind === 'omitted').length, 4);
  assert.match(result.handoff.sessionUrl, /^\/api\/sessions\//);
});

test('frozen pages exclude appends; incremental cursors finish snapshots then read newly completed records', async t => {
  const f = await fixture(t);
  await appendFile(f.file, serialize([message('first'), message('second')]));
  const first = await f.service.detail(f.id, new URLSearchParams({ limit: '1' }));
  await appendFile(f.file, serialize([message('new')]) + '{"type":');
  let page = await f.service.detail(f.id, new URLSearchParams({ cursor: first.nextCursor! }));
  assert.equal(page.version, first.version); assert.doesNotMatch(JSON.stringify(page.events), /"new"/);
  assert.equal(page.events.length, 2);
  const increment = await f.service.events(f.id, new URLSearchParams({ after: page.eventCursor }));
  assert.match(JSON.stringify(increment.events), /"new"/); assert.equal(increment.events.length, 1);
  assert.ok(increment.coverage.pendingBytes > 0);
  assert.equal((await f.service.events(f.id, new URLSearchParams({ after: increment.eventCursor }))).events.length, 0);
  await appendFile(f.file, '"event_msg","payload":{"type":"task_complete"}}\n');
  const finished = await f.service.events(f.id, new URLSearchParams({ after: increment.eventCursor }));
  assert.equal(finished.events.length, 1); assert.match(JSON.stringify(finished.events), /task_complete/);
  assert.equal(finished.coverage.pendingBytes, 0);
  // A handoff URL can re-read the exact original version.
  const frozen = await f.service.detail(f.id, new URLSearchParams({ cursor: first.snapshot }));
  assert.equal(frozen.version, first.version); assert.equal(frozen.events.length, 3);
});

test('large records are retrieved by authenticated signed reference without text truncation', async t => {
  const f = await fixture(t), content = 'large-output-'.repeat(100000);
  await appendFile(f.file, serialize([{ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-big', output: content } }]));
  const first = await f.service.detail(f.id);
  const second = await f.service.detail(f.id, new URLSearchParams({ cursor: first.nextCursor! }));
  assert.equal(second.events[0]!.kind, 'reference');
  const url = new URL(String(second.events[0]!.href), 'http://localhost');
  const record = await f.service.record(f.id, url.searchParams);
  assert.ok(JSON.stringify(record.event).includes(content));
  await assert.rejects(f.service.detail(f.id, new URLSearchParams({ cursor: url.searchParams.get('ref')! })), /引用/);
});

test('detects file replacement, same-size rewrite, cursor tampering and cross-runtime cursor reuse', async t => {
  const f = await fixture(t);
  await appendFile(f.file, serialize([message('alpha')]));
  const result = await f.service.detail(f.id);
  await writeFile(f.file, serialize([f.meta, message('bravo')]));
  await assert.rejects(f.service.detail(f.id, new URLSearchParams({ cursor: result.snapshot })), { statusCode: 409 });
  const current = await f.service.detail(f.id);
  await rename(f.file, f.file + '.old'); await writeFile(f.file, serialize([f.meta, message('bravo')]));
  await assert.rejects(f.service.events(f.id, new URLSearchParams({ after: current.eventCursor })), { statusCode: 409 });
  await assert.rejects(f.service.detail(f.id, new URLSearchParams({ cursor: current.snapshot + 'x' })), { statusCode: 409 });
  const other = createSessionDelivery({ history: f.history });
  await assert.rejects(other.detail(f.id, new URLSearchParams({ cursor: current.snapshot })), { statusCode: 409 });
  await assert.rejects(f.service.events(f.id), { statusCode: 400 });
  await assert.rejects(f.service.detail(f.id, new URLSearchParams({ limit: '0' })), { statusCode: 400 });
  await assert.rejects(f.service.detail('../session.jsonl'), { statusCode: 404 });
});

test('does not read symlink targets or conversations outside the configured workspace', async t => {
  const f = await fixture(t, 'workspace');
  const result = await f.service.detail(f.id);
  const outside = path.join(f.root, 'outside.jsonl');
  await writeFile(outside, serialize([f.meta, message('private')]));
  await rm(f.file); await symlink(outside, f.file);
  await assert.rejects(f.service.detail(f.id, new URLSearchParams({ cursor: result.snapshot })), { statusCode: 404 });
  await rm(f.file); await writeFile(f.file, serialize([f.meta, { type: 'turn_context', payload: { cwd: f.root } }, message('outside')]));
  await assert.rejects(f.service.detail(f.id), { statusCode: 404 });
});

test('lists by agent, keyword, workspace and time; Claude tool data is preserved', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.records, 'claude.jsonl'), serialize([
    { type: 'user', timestamp, sessionId: 'claude-task', cwd: f.workspace, message: { role: 'user', content: 'claude-request' } },
    { type: 'assistant', timestamp, sessionId: 'claude-task', cwd: f.workspace, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', input: { command: 'echo ok' } }, { type: 'thinking', thinking: 'hidden-thought' }] } },
    { type: 'user', timestamp, sessionId: 'claude-task', cwd: f.workspace, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'ok' }] }] } }
  ]));
  const matches = await f.service.list(new URLSearchParams({ agent: 'claude', q: 'claude-request', workspace: f.workspace, from: '2026-09-01', to: '2026-10-01' }));
  assert.equal(matches.total, 1);
  const detail = await f.service.detail(matches.sessions[0]!.id);
  assert.match(JSON.stringify(detail.events), /tool_use_id/); assert.doesNotMatch(JSON.stringify(detail.events), /hidden-thought/);
  assert.equal((await f.service.list(new URLSearchParams({ from: '2099-01-01' }))).total, 0);
  await assert.rejects(f.service.list(new URLSearchParams({ from: 'bad' })), { statusCode: 400 });
});

test('paginates past 10000 source records and surfaces malformed lines explicitly', async t => {
  const f = await fixture(t);
  await appendFile(f.file, serialize(Array.from({ length: 10005 }, (_, n) => message(`message-${n}`))) + 'broken-json\n');
  let page = await f.service.detail(f.id, new URLSearchParams({ limit: '200' })), count = page.events.length;
  while (page.nextCursor) { page = await f.service.detail(f.id, new URLSearchParams({ cursor: page.nextCursor, limit: '200' })); count += page.events.length; }
  assert.equal(count, 10007); assert.match(JSON.stringify(page.events), /message-10004/);
  assert.equal(page.coverage.unavailableRecords, 1);
});

test('scans past 64 MiB and marks oversized individual records unavailable instead of dropping the tail', async t => {
  const f = await fixture(t);
  const handle = await open(f.file, 'a');
  try {
    await handle.write('{"type":"large","text":"');
    const block = Buffer.alloc(1024 * 1024, 'x');
    for (let n = 0; n < 65; n++) await handle.write(block);
    await handle.write('"}\n' + serialize([message('tail-after-64-mib')]));
  } finally { await handle.close(); }
  const result = await f.service.detail(f.id);
  assert.ok(result.coverage.sourceBytes > 64 * 1024 * 1024);
  assert.match(JSON.stringify(result.events), /tail-after-64-mib/);
  assert.equal(result.coverage.unavailableRecords, 1);
});

test('credential redaction preserves ordinary content and reports transformations', () => {
  const record = deliverRecord('claude', { message: { content: [{ type: 'text', text: 'Authorization: Bearer token-for-testing password is discussed here' }, { type: 'tool_use', input: { password: 'do-not-send', api_key: 'private' } }] } }, {});
  const text = JSON.stringify(record);
  assert.doesNotMatch(text, /token-for-testing|do-not-send|"private"/); assert.match(text, /password is discussed/); assert.ok(record.redactions >= 3);
});

test('HTTP handoff requires a member session and respects tenant source boundaries', async t => {
  const f = await fixture(t);
  const setupToken = 'synthetic-setup-'.repeat(4);
  const app = createApp({ rootDir: f.root, environment: { ...f.environment, DEFAULT_TENANT_TOKEN: setupToken } });
  t.after(() => app.close());
  const otherSetup = 'other-setup-'.repeat(4);
  const database = openDatabase(app.filename);
  database.createTenant({ id: 'other', name: 'Other', token: otherSetup });
  database.close();
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  async function request(token: string | null, route: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request(null, '/api/sessions')).status, 401);
  await request(setupToken, '/api/auth/setup', 'POST', { username: 'owner', password: 'synthetic-owner-password' });
  const owner = (await request(null, '/api/auth/login', 'POST', { tenantId: 'default', username: 'owner', password: 'synthetic-owner-password' })).body.token;
  await request(owner, '/api/organization/members', 'POST', { username: 'viewer', password: 'synthetic-viewer-password', role: 'viewer' });
  const viewer = (await request(null, '/api/auth/login', 'POST', { tenantId: 'default', username: 'viewer', password: 'synthetic-viewer-password' })).body.token;
  await request(otherSetup, '/api/auth/setup', 'POST', { username: 'other', password: 'synthetic-other-password' });
  const other = (await request(null, '/api/auth/login', 'POST', { tenantId: 'other', username: 'other', password: 'synthetic-other-password' })).body.token;
  const catalog = await request(viewer, '/api/sessions?agent=codex');
  assert.equal(catalog.status, 200);
  const route = catalog.body.sessions[0].href;
  const detail = await request(viewer, route);
  assert.equal(detail.status, 200);
  assert.equal((await request(other, '/api/sessions')).body.total, 0);
  assert.equal((await request(other, detail.body.handoff.sessionUrl)).status, 404);
  assert.equal((await request(null, detail.body.handoff.sessionUrl)).status, 401);
  assert.equal((await request(viewer, detail.body.handoff.incrementalUrl)).status, 200);
  await request(viewer, '/api/auth/logout', 'POST');
  assert.equal((await request(viewer, detail.body.handoff.sessionUrl)).status, 401);
});
