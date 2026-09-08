import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createAgentHistory } from '../src/agentHistory/index.mjs';
import { createApp } from '../server.mjs';
import { canonicalWorkspace } from '../src/tenancy.mjs';

const timestamp = '2026-09-08T01:00:00Z';
const codex = (cwd, id = 'same-id') => [
  { type: 'session_meta', timestamp, payload: { id, cwd, timestamp, git: { branch: 'main' } } },
  { type: 'event_msg', timestamp, payload: { type: 'user_message', message: '修复登录' } },
  { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修复登录' }] } },
  { type: 'response_item', timestamp, payload: { type: 'function_call', name: 'exec', call_id: 'call-1', arguments: '{"cmd":"test"}' } },
  { type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: 'call-1', output: 'passed' } },
  { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<script>alert(1)</script>' }] } },
  { type: 'event_msg', timestamp, payload: { type: 'agent_message', message: '<script>alert(1)</script>' } },
  { type: 'event_msg', timestamp, payload: { type: 'task_complete' } }
];
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'repo'), other = path.join(root, 'repo-other');
  const codexDir = path.join(root, 'codex'), claudeDir = path.join(root, 'claude');
  await Promise.all([workspace, other, codexDir, claudeDir].map((dir) => mkdir(dir)));
  const environment = { IDE_HISTORY_CODEX_DIR: codexDir, IDE_HISTORY_CLAUDE_DIR: claudeDir };
  const save = async (file, rows) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n'); };
  return { root, workspace, other, codexDir, claudeDir, environment, save, history: createAgentHistory({ environment, workspace: () => workspace }) };
}

test('normalizes both agents, deduplicates Codex events, filters and paginates', async (t) => {
  const f = await fixture(t);
  await f.save(path.join(f.codexDir, 'one.jsonl'), codex(f.workspace));
  await f.save(path.join(f.claudeDir, 'one.jsonl'), [
    { type: 'user', sessionId: 'same-id', cwd: f.workspace, timestamp, message: { content: 'Claude 任务' } },
    { type: 'assistant', cwd: f.workspace, timestamp: '2026-09-08T02:00:00Z', message: { model: 'test-model', stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }, { type: 'tool_use', name: 'Read', id: 'read', input: { file: 'a' } }] } },
    { type: 'user', cwd: f.workspace, message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'ok' }] } }
  ]);
  const list = await f.history.list();
  assert.equal(list.total, 2);
  assert.equal(new Set(list.sessions.map((s) => s.id)).size, 2);
  assert.equal(list.sessions[0].agent, 'claude');
  const filtered = await f.history.list(new URLSearchParams({ agent: 'codex', q: '登录', limit: '1' }));
  assert.equal(filtered.total, 1);
  assert.equal(filtered.sessions[0].messageCount, 4);
  assert.equal(filtered.sessions[0].status, 'completed');
  assert.equal(filtered.sessions[0].messages, undefined);
  const detail = await f.history.detail(filtered.sessions[0].id, new URLSearchParams({ offset: '1', limit: '2' }));
  assert.deepEqual(detail.messages.map((m) => m.role), ['tool_call', 'tool_result']);
  assert.equal(detail.total, 4);
  const claudeDetail = await f.history.detail(list.sessions[0].id);
  assert.equal(claudeDetail.messages.at(-1).text, 'ok');
  await assert.rejects(f.history.list(new URLSearchParams({ agent: 'missing' })), { statusCode: 400 });
  await assert.rejects(f.history.list(new URLSearchParams({ limit: 'NaN' })), { statusCode: 400 });
});

test('optional workspace scope isolates symlinks, missing metadata, changed cwd and direct IDs', async (t) => {
  const f = await fixture(t);
  f.environment.IDE_HISTORY_SCOPE = 'workspace';
  await f.save(path.join(f.codexDir, 'own.jsonl'), codex(f.workspace));
  await f.save(path.join(f.codexDir, 'other.jsonl'), codex(f.other));
  await f.save(path.join(f.codexDir, 'missing.jsonl'), codex(undefined));
  await f.save(path.join(f.codexDir, 'changed.jsonl'), [...codex(f.workspace), { type: 'turn_context', payload: { cwd: f.other } }]);
  await symlink(f.other, path.join(f.workspace, 'escape'));
  await f.save(path.join(f.codexDir, 'escape.jsonl'), codex(path.join(f.workspace, 'escape')));
  await f.save(path.join(f.other, 'outside.jsonl'), codex(f.workspace));
  await symlink(path.join(f.other, 'outside.jsonl'), path.join(f.codexDir, 'link.jsonl'));
  const list = await f.history.list();
  assert.equal(list.total, 1);
  const otherHistory = createAgentHistory({ environment: f.environment, tenantId: 'other', workspace: () => f.other });
  await assert.rejects(otherHistory.detail(list.sessions[0].id), { statusCode: 404 });
  await assert.rejects(f.history.detail('../../secret'), { statusCode: 404 });
  const unconfigured = createAgentHistory({ environment: {}, tenantId: 'other', workspace: () => f.workspace });
  assert.ok((await unconfigured.list()).providers.every((p) => p.status === 'unconfigured'));
});

test('refreshes appended and deleted sessions and tolerates partial JSONL', async (t) => {
  const f = await fixture(t), file = path.join(f.codexDir, 'one.jsonl');
  await f.save(file, codex(f.workspace));
  const first = (await f.history.list()).sessions[0];
  await appendFile(file, '{broken}\n' + JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'thread_name_updated', thread_name: '新名称' } }) + '\n');
  const updated = (await f.history.list()).sessions[0];
  assert.equal(updated.id, first.id);
  assert.equal(updated.title, '新名称');
  assert.equal(updated.partial, true);
  await rm(file);
  assert.equal((await f.history.list()).total, 0);
  await assert.rejects(f.history.detail(first.id), { statusCode: 404 });
});

test('supports additional adapters without changing the service contract', async (t) => {
  const f = await fixture(t);
  await f.save(path.join(f.codexDir, 'extra.jsonl'), [{ cwd: f.workspace, timestamp, prompt: 'hello' }]);
  const adapter = { id: 'custom', label: 'Custom Agent', roots: () => [f.codexDir], decode: (row) => ({ cwd: row.cwd, entries: [{ role: 'user', text: row.prompt, timestamp: row.timestamp }] }) };
  const history = createAgentHistory({ workspace: () => f.workspace, adapters: [adapter] });
  const list = await history.list();
  assert.equal(list.sessions[0].agent, 'custom');
  assert.equal((await history.detail(list.sessions[0].id)).messages[0].text, 'hello');
  assert.throws(() => createAgentHistory({ workspace: () => f.workspace, adapters: [adapter, adapter] }));
});

test('reads archived event-only logs and marks long text truncation explicitly', async (t) => {
  const f = await fixture(t);
  await f.save(path.join(f.codexDir, 'archived_sessions', 'old.jsonl'), [
    { type: 'session_meta', timestamp, payload: { id: 'old', cwd: f.workspace } },
    { type: 'event_msg', timestamp, payload: { type: 'user_message', message: '旧会话' } },
    { type: 'event_msg', timestamp, payload: { type: 'agent_message', message: 'x'.repeat(25000) } },
    { type: 'event_msg', timestamp, payload: { type: 'turn_aborted' } }
  ]);
  const list = await f.history.list();
  assert.equal(list.sessions[0].archived, true);
  assert.equal(list.sessions[0].status, 'interrupted');
  const detail = await f.history.detail(list.sessions[0].id);
  assert.equal(detail.total, 2);
  assert.match(detail.messages[1].text, /已截断/);
  assert.ok(detail.messages[1].text.length < 25000);
});

test('history HTTP API requires member authentication and supports viewer read access', async (t) => {
  const f = await fixture(t), token = 'history-setup-token-'.repeat(3), password = 'history-test-password';
  await f.save(path.join(f.codexDir, 'one.jsonl'), codex(f.workspace));
  const app = createApp({ rootDir: f.root, environment: { ...f.environment, CODEX_WORKSPACE_DIR: f.workspace, DEFAULT_TENANT_TOKEN: token } });
  t.after(() => app.close());
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(endpoint, auth, method = 'GET', body) {
    const response = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await request('/api/agent-sessions')).status, 401);
  assert.equal((await request('/api/auth/setup', token, 'POST', { username: 'owner', password })).status, 201);
  const owner = (await request('/api/auth/login', null, 'POST', { tenantId: 'default', username: 'owner', password })).data.token;
  await request('/api/organization/members', owner, 'POST', { username: 'viewer', password, role: 'viewer' });
  const viewer = (await request('/api/auth/login', null, 'POST', { tenantId: 'default', username: 'viewer', password })).data.token;
  const result = await request('/api/agent-sessions', viewer);
  assert.equal(result.status, 200);
  assert.equal(result.data.total, 1);
  assert.equal((await request(`/api/agent-sessions/${result.data.sessions[0].id}`, viewer)).data.messages.length, 4);
  assert.equal((await request('/api/agent-sessions', viewer, 'POST', {})).status, 404);
});

test('all-workspace history includes other projects and missing cwd, and filters exact workspaces', async (t) => {
  const f = await fixture(t);
  await f.save(path.join(f.codexDir, 'one.jsonl'), codex(f.workspace, 'one'));
  await f.save(path.join(f.codexDir, 'two.jsonl'), codex(f.other, 'two'));
  await f.save(path.join(f.codexDir, 'unknown.jsonl'), codex(undefined, 'unknown'));
  await f.save(path.join(f.codexDir, 'unrelated.jsonl'), [{ type: 'unrelated' }]);
  const list = await f.history.list();
  assert.equal(list.total, 3);
  assert.equal(list.scope, 'all');
  assert.equal(list.workspaces.length, 3);
  const project = await f.history.list(new URLSearchParams({ workspace: canonicalWorkspace(f.other) }));
  assert.equal(project.total, 1);
  assert.equal(project.sessions[0].sessionId, 'two');
  assert.equal((await f.history.detail(project.sessions[0].id)).messages.length, 4);
  const unknown = await f.history.list(new URLSearchParams({ workspace: '__unknown__' }));
  assert.equal(unknown.total, 1);
  assert.equal(unknown.sessions[0].sessionId, 'unknown');
  assert.equal((await f.history.list(new URLSearchParams({ workspace: path.dirname(f.workspace) }))).total, 0);
  const noWorkspace = createAgentHistory({ environment: f.environment, workspace: () => '' });
  assert.equal((await noWorkspace.list()).total, 3);
});

test('multiple cwd values are filterable, and non-default tenants use only configured sources', async (t) => {
  const f = await fixture(t);
  await f.save(path.join(f.codexDir, 'multi.jsonl'), [...codex(f.workspace), { type: 'turn_context', payload: { cwd: f.other } }]);
  assert.equal((await f.history.list(new URLSearchParams({ workspace: canonicalWorkspace(f.other) }))).total, 1);
  const isolated = createAgentHistory({ tenantId: 'other', environment: { HOME: f.root }, workspace: () => f.workspace });
  assert.equal((await isolated.list()).total, 0);
  const customSource = createAgentHistory({ tenantId: 'other', environment: { IDE_HISTORY_CODEX_DIR: f.claudeDir }, workspace: () => f.workspace });
  assert.equal((await customSource.list()).total, 0);
});

test('hides injected context before deriving titles, retaining mixed user text and images', async (t) => {
  const f = await fixture(t);
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  await f.save(path.join(f.codexDir, 'context.jsonl'), [
    { type: 'session_meta', timestamp, payload: { id: 'context', cwd: f.workspace } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>list</recommended_plugins><environment_context>cwd</environment_context>' }] } },
    { type: 'event_msg', timestamp, payload: { type: 'user_message', message: '<recommended_plugins>list</recommended_plugins>' } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>env</environment_context>检查这张图片' }, { type: 'input_image', image_url: image }] } }
  ]);
  const list = await f.history.list();
  assert.equal(list.sessions[0].title, '检查这张图片');
  assert.equal(list.sessions[0].messageCount, 1);
  assert.equal(JSON.stringify(list).includes('base64'), false);
  const detail = await f.history.detail(list.sessions[0].id);
  assert.equal(detail.messages[0].text, '检查这张图片');
  assert.equal(detail.messages[0].images[0].dataUrl, image);
});

test('preserves image-only messages from Codex and Claude', async (t) => {
  const f = await fixture(t);
  for (const [dir, row] of [
    [f.codexDir, { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }] } }],
    [f.claudeDir, { type: 'user', cwd: f.workspace, sessionId: 'image-only', timestamp, message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] } }]
  ]) await f.save(path.join(dir, 'image.jsonl'), [{ type: 'session_meta', timestamp, payload: { id: 'image', cwd: f.workspace } }, row]);
  const list = await f.history.list();
  assert.equal(list.total, 2);
  for (const session of list.sessions) {
    assert.equal(session.messageCount, 1);
    const detail = await f.history.detail(session.id);
    assert.equal(detail.messages[0].text, '');
    assert.equal(detail.messages[0].images[0].dataUrl, 'data:image/png;base64,aGVsbG8=');
  }
});
