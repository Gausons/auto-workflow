import assert from 'node:assert/strict';
import test from 'node:test';
import { createIssueSource, sourceStorageKey, syncCheckpoint } from '../src/issueSources/index.ts';
import { buildJiraJql, jiraDescription, normalizeJiraIssue } from '../src/issueSources/jira.ts';
import { sourceTransitionPlan } from '../src/issueSources/workflow.ts';
import { tenantEnvironment } from '../src/tenancy.js';
import type { Environment, IssueSourceFactory } from '../src/issueSources/types.ts';

const environment: Environment = {
  ISSUE_PROVIDER: 'jira', JIRA_BASE_URL: 'https://jira.example.com', JIRA_EMAIL: 'test@example.com',
  JIRA_API_TOKEN: 'fictional-test-token', JIRA_JQL: 'project = DEMO OR project = OTHER'
};
const rawIssue = (id = '100', category = 'new') => ({
  id, key: `DEMO-${id}`, fields: {
    summary: 'Synthetic test issue', description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reproduce failure' }, { type: 'hardBreak' }, { type: 'mention', attrs: { text: '@tester' } }] }] },
    status: { name: 'Custom status', statusCategory: { key: category } }, priority: { name: 'High' },
    assignee: { accountId: 'account-a', displayName: 'Test member' }, project: { name: 'Demo' }, issuetype: { name: 'Bug' },
    created: '2026-01-01T00:00:00.000Z', updated: '2026-01-02T00:00:00.000Z',
    attachment: [{ id: '12', filename: 'example.txt', content: 'https://jira.example.com/rest/api/3/attachment/content/12', size: 4, mimeType: 'text/plain' }]
  }
});
function source(fetcher: typeof fetch, overrides: Environment = {}) {
  return createIssueSource({ environment: { ...environment, ...overrides }, config: {}, fetch: fetcher });
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('Jira normalizes ADF, status categories, priorities, null users and attachment metadata', () => {
  const issue = normalizeJiraIssue(rawIssue(), 'https://jira.example.com');
  assert.equal(issue.id, 'jira:100');
  assert.equal(issue.aid, '100');
  assert.equal(issue.sourceUrl, 'https://jira.example.com/browse/DEMO-100');
  assert.equal(issue.description, 'Reproduce failure\n@tester');
  assert.equal(issue.status, '待处理');
  assert.equal(issue.sourceStatus, 'Custom status');
  assert.equal(issue.priority, 'P1');
  assert.equal(issue.attachments?.[0]?.contentType, 'text/plain');
  assert.equal(normalizeJiraIssue(rawIssue('1', 'done'), '').status, '已完成');
  assert.equal(normalizeJiraIssue(rawIssue('1', 'indeterminate'), '').status, '处理中');
  assert.equal(normalizeJiraIssue(rawIssue(), '', { High: 'P2' }).priority, 'P2');
  assert.equal(normalizeJiraIssue({ ...rawIssue(), fields: { ...rawIssue().fields, assignee: null } }, '').assigneeId, '');
  assert.equal(jiraDescription('Plain text'), 'Plain text');
  assert.equal(jiraDescription(null), '');
  assert.throws(() => normalizeJiraIssue({}, ''), /summary/);
});

test('JQL groups OR filters and uses an overlapping epoch checkpoint without timezone ambiguity', () => {
  const since = '2026-01-02T01:02:03.000Z';
  assert.equal(buildJiraJql('project = A OR project = B', since), `(project = A OR project = B) AND updated >= ${Date.parse(since) - 300000} ORDER BY updated ASC, key ASC`);
  assert.throws(() => buildJiraJql('project = A ORDER BY created'), /ORDER BY/);
  assert.throws(() => buildJiraJql('project = A', 'bad date'), /时间/);
  assert.match(buildJiraJql('summary ~ "order by"'), /summary/);
});

test('Jira enhanced search follows short pages by cursor and deduplicates IDs', async () => {
  const requests: RequestInit[] = [];
  const jira = source(async (input, init) => {
    assert.equal(String(input), 'https://jira.example.com/rest/api/3/search/jql');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    requests.push(init!);
    return json(requests.length === 1 ? { issues: [rawIssue()], nextPageToken: 'next', isLast: false } : { issues: [rawIssue(), rawIssue('101')], isLast: true });
  });
  const issues = await jira.sync({});
  assert.equal(issues.length, 2);
  assert.equal(JSON.parse(String(requests[1]!.body)).nextPageToken, 'next');
  assert.equal(new Headers(requests[0]!.headers).get('authorization'), `Basic ${Buffer.from('test@example.com:fictional-test-token').toString('base64')}`);
  assert.equal(JSON.stringify(issues).includes('fictional-test-token'), false);
});

test('Jira fails closed on truncation, repeated cursors and malformed responses', async () => {
  await assert.rejects(source(async () => json({ issues: [rawIssue()], nextPageToken: 'next' }), { JIRA_MAX_PAGES: '1' }).sync({}), /MAX_PAGES/);
  await assert.rejects(source(async () => json({ issues: [], nextPageToken: 'same', isLast: false })).sync({}), /游标/);
  await assert.rejects(source(async () => json({ issues: [], isLast: false })).sync({}), /游标/);
  await assert.rejects(source(async () => json({})).sync({}), /issues/);
  await assert.rejects(source(async () => new Response('not json')).sync({}), /JSON/);
});

test('Jira retries bounded 429s and never exposes remote bodies or connection secrets', async () => {
  let calls = 0;
  const jira = source(async () => ++calls === 1 ? new Response('secret', { status: 429, headers: { 'retry-after': '0' } }) : json({ issues: [], isLast: true }));
  assert.deepEqual(await jira.sync({}), []);
  assert.equal(calls, 2);
  for (const status of [401, 403, 500]) {
    await assert.rejects(source(async () => json({ error: 'fictional-test-token' }, status)).sync({}), error => {
      assert.match(String(error), new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(String(error), /fictional-test-token/);
      return true;
    });
  }
  await assert.rejects(source(async () => { throw new Error('fictional-test-token'); }).sync({}), /连接失败/);
  await assert.rejects(source(async () => new Response('', { status: 429, headers: { 'retry-after': '120' } })).sync({}), /限流/);
});

test('Jira assignment uses accountId and attachments use the issue endpoint, not another source', async () => {
  const calls: [string, RequestInit | undefined][] = [];
  const jira = source(async (input, init) => {
    calls.push([String(input), init]);
    return init?.method === 'PUT' ? new Response(null, { status: 204 }) : json({ fields: { attachment: rawIssue().fields.attachment } });
  }, { JIRA_ACCESS_TOKEN: 'fictional-oauth-token' });
  await jira.assign({ aid: '100' }, 'account-b');
  assert.equal(calls[0]![0], 'https://jira.example.com/rest/api/3/issue/100/assignee');
  assert.deepEqual(JSON.parse(String(calls[0]![1]?.body)), { accountId: 'account-b' });
  assert.equal(new Headers(calls[0]![1]?.headers).get('authorization'), 'Bearer fictional-oauth-token');
  assert.equal((await jira.attachments({ aid: '100' }))[0]?.id, '12');
  assert.match(calls[1]![0], /issue\/100\?fields=attachment$/);
});

test('authenticated attachments strip credentials on CDN redirects and enforce streaming byte limits', async () => {
  const seen: (string | null)[] = [];
  const jira = source(async (_input, init) => {
    seen.push(new Headers(init?.headers).get('authorization'));
    return seen.length === 1 ? new Response(null, { status: 303, headers: { location: 'https://cdn.example.com/file' } }) : new Response('file');
  });
  const url = rawIssue().fields.attachment[0]!.content;
  assert.equal(Buffer.from(await jira.downloadAttachment!(url, 4)).toString(), 'file');
  assert.ok(seen[0]);
  assert.equal(seen[1], null);
  await assert.rejects(jira.downloadAttachment!('https://evil.example.com/file', 10), /地址/);
  await assert.rejects(source(async () => new Response('too large')).downloadAttachment!(url, 2), /大小限制/);
});

test('configuration validation, source registration and storage preserve existing storage isolation', () => {
  const noFetch: typeof fetch = async () => { throw new Error('unexpected network'); };
  assert.throws(() => source(noFetch, { JIRA_BASE_URL: 'http://jira.example.com' }).validate(), /HTTPS/);
  assert.throws(() => source(noFetch, { JIRA_API_TOKEN: '' }).validate(), /JIRA_EMAIL/);
  assert.throws(() => source(noFetch, { JIRA_PRIORITY_MAP: '{"High":"urgent"}' }).validate(), /PRIORITY_MAP/);
  assert.throws(() => createIssueSource({ config: {}, environment: { ISSUE_PROVIDER: 'unknown' } }), /不支持/);
  const primarySource = createIssueSource({ config: {}, environment: {} });
  const legacySource = { ...primarySource, id: 'fixture', storageScope: '' };
  assert.equal(primarySource.id, 'jira');
  assert.equal(sourceStorageKey(legacySource, 'legacy-user'), 'legacy-user');
  assert.notEqual(sourceStorageKey(source(noFetch), 'default'), 'default');
  assert.notEqual(source(noFetch).storageScope, source(noFetch, { JIRA_BASE_URL: 'https://other.example.com' }).storageScope);
  assert.notEqual(source(noFetch).storageScope, source(noFetch, { JIRA_JQL: 'project = OTHER' }).storageScope);
  const factory: IssueSourceFactory = () => ({ ...primarySource, id: 'custom' });
  assert.equal(createIssueSource({ config: {}, environment: { ISSUE_PROVIDER: 'custom' } }, { custom: factory }).id, 'custom');
  assert.equal(syncCheckpoint(source(noFetch), new Date('2026-01-01T00:00:00Z')), '2026-01-01T00:00:00.000Z');
  const other: Environment = tenantEnvironment({ id: 'other' }, '/nonexistent-test-directory', environment);
  assert.equal(other.JIRA_API_TOKEN, undefined);
  assert.equal(other.ISSUE_PROVIDER, undefined);
  const primary: Environment = tenantEnvironment({ id: 'default' }, '/nonexistent-test-directory', environment);
  assert.equal(primary.ISSUE_PROVIDER, 'jira');
});


test('workflow transition plan directs users to the original platform without embedded endpoints', () => {
  const plan = sourceTransitionPlan({ source: 'jira', sourceUrl: 'https://jira.example.com/browse/DEMO-1' });
  assert.equal(plan.automaticTransition, false);
  assert.equal(plan.issueUrl, 'https://jira.example.com/browse/DEMO-1');
  assert.doesNotMatch(JSON.stringify(plan), /operationsEndpoint/);
});
