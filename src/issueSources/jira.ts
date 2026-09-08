import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { IssueAttachment, IssueSourceFactory, WorkIssue } from './types.ts';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const bounded = (value: unknown, fallback: number, max: number): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

/** Atlassian Document Format to plain text; raw HTML and credentials are never retained. */
export function jiraDescription(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value;
  if (depth > 40) return '';
  const node = object(value);
  if (node.type === 'text') return text(node.text);
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return text(object(node.attrs).text);
  const content = list(node.content).map(child => jiraDescription(child, depth + 1)).join('');
  return content + (['paragraph', 'heading', 'listItem', 'codeBlock', 'tableRow'].includes(text(node.type)) ? '\n' : '');
}

function attachments(value: unknown): IssueAttachment[] {
  return list(value).map(object).map(a => ({
    id: text(a.id), name: text(a.filename), url: text(a.content),
    thumbnailUrl: text(a.thumbnail), contentType: text(a.mimeType),
    size: typeof a.size === 'number' ? a.size : 0
  }));
}

export function normalizeJiraIssue(value: unknown, site: string, priorityMap: Record<string, string> = {}): WorkIssue {
  const issue = object(value), fields = object(issue.fields);
  if (!text(issue.id) || !text(issue.key) || !text(fields.summary)) throw new Error('Jira 返回了缺少 id、key 或 summary 的问题。');
  const status = object(fields.status), category = text(object(status.statusCategory).key);
  const priority = text(object(fields.priority).name);
  const defaults: Record<string, string> = { highest: 'P0', high: 'P1', medium: 'P2', low: 'P3', lowest: 'P3' };
  return {
    id: `jira:${text(issue.id)}`, aid: text(issue.id), code: text(issue.key), title: text(fields.summary),
    source: 'jira', sourceId: text(issue.id), sourceUrl: `${site}/browse/${encodeURIComponent(text(issue.key))}`,
    sourceStatus: text(status.name),
    status: ({ new: '待处理', indeterminate: '处理中', done: '已完成' } as Record<string, string>)[category] || text(status.name) || '未知',
    priority: priorityMap[priority] || (/^P[0-3]$/.test(priority) ? priority : defaults[priority.toLowerCase()]) || '未设置',
    severity: '未设置', assignee: text(object(fields.assignee).displayName), assigneeId: text(object(fields.assignee).accountId),
    product: text(object(fields.project).name), category: text(object(fields.issuetype).name),
    description: jiraDescription(fields.description).trim(), createdAt: text(fields.created), updatedAt: text(fields.updated),
    attachments: attachments(fields.attachment), attachmentsLoaded: Array.isArray(fields.attachment)
  };
}

/** JQL filter expression only; ordering is owned here so incremental predicates remain valid. */
export function buildJiraJql(expression: string, lastSyncTime?: string | null): string {
  if (!expression.trim()) throw new Error('请配置 JIRA_JQL，例如 project = DEMO。');
  // Inspect only outside quoted literals, allowing summaries containing "order by".
  const unquoted = expression.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '');
  if (/\border\s+by\b/i.test(unquoted)) throw new Error('JIRA_JQL 只填写筛选条件，不包含 ORDER BY。');
  let filter = `(${expression.trim()})`;
  if (lastSyncTime) {
    const timestamp = Date.parse(lastSyncTime);
    if (!Number.isFinite(timestamp)) throw new Error('Jira 增量同步时间无效。');
    // Numeric epoch avoids Jira user/server timezone ambiguity; overlap covers indexing delays.
    filter += ` AND updated >= ${Math.max(0, timestamp - 5 * 60_000)}`;
  }
  return `${filter} ORDER BY updated ASC, key ASC`;
}

export const createJiraSource: IssueSourceFactory = ({ environment: env, fetch: fetcher = globalThis.fetch }) => {
  const root = (env.JIRA_BASE_URL || '').trim().replace(/\/+$/, '');
  const site = (env.JIRA_SITE_URL || root).trim().replace(/\/+$/, '');
  const jql = env.JIRA_JQL || '';
  const configured = Boolean(env.JIRA_ACCESS_TOKEN || (env.JIRA_EMAIL && env.JIRA_API_TOKEN));
  const authorization = env.JIRA_ACCESS_TOKEN ? `Bearer ${env.JIRA_ACCESS_TOKEN}` : `Basic ${Buffer.from(`${env.JIRA_EMAIL || ''}:${env.JIRA_API_TOKEN || ''}`).toString('base64')}`;
  const maxPages = bounded(env.JIRA_MAX_PAGES, 50, 1000);
  const pageSize = bounded(env.JIRA_PAGE_SIZE, 100, 100);
  const timeout = bounded(env.JIRA_TIMEOUT_MS, 30_000, 120_000);
  let priorityMap: Record<string, string> = {};

  function validate() {
    for (const value of [root, site]) {
      let url: URL;
      try { url = new URL(value); } catch { throw new Error('请配置有效的 JIRA_BASE_URL / JIRA_SITE_URL。'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Jira 地址必须是无凭据、查询参数和片段的 HTTPS 地址。');
    }
    if (!configured) throw new Error('请配置 JIRA_EMAIL / JIRA_API_TOKEN，或 JIRA_ACCESS_TOKEN。');
    buildJiraJql(jql);
    try {
      const parsed: unknown = JSON.parse(env.JIRA_PRIORITY_MAP || '{}');
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(v => typeof v !== 'string' || !/^P[0-3]$/.test(v))) throw new Error();
      priorityMap = parsed as Record<string, string>;
    } catch { throw new Error('JIRA_PRIORITY_MAP 必须是将 Jira 优先级名称映射为 P0–P3 的 JSON 对象。'); }
  }

  async function request(endpoint: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<unknown> {
    validate();
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await fetcher(`${root}/rest/api/3/${endpoint}`, {
          method, redirect: 'error', signal: AbortSignal.timeout(timeout),
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: authorization },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
      } catch { throw new Error('Jira 请求连接失败或超时，请检查服务地址及网络。'); }
      if (response.status === 429 && attempt < 2) {
        const retry = response.headers.get('retry-after');
        const seconds = retry === null ? NaN : Number(retry);
        const wait = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - Date.now() : 1000;
        await response.body?.cancel();
        // Do not retry earlier than the server permits; long waits fail for a later sync.
        if (!Number.isFinite(wait) || wait > 30_000) throw new Error('Jira 限流，请稍后重新同步。');
        await delay(Math.max(0, wait));
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        // Never include remote bodies: they may echo JQL, tokens or personal information.
        throw new Error(`Jira API HTTP ${response.status}，请检查凭据、权限、JQL 或稍后重试。`);
      }
      if (response.status === 204) return {};
      try { return await response.json(); } catch { throw new Error('Jira 返回了无效 JSON。'); }
    }
    throw new Error('Jira 限流重试失败。');
  }

  return {
    id: 'jira', label: 'Jira Cloud', configured, validate, assignmentOperationCode: 'jira/assign',
    storageScope: `jira-${createHash('sha256').update(JSON.stringify([root, jql])).digest('hex').slice(0, 24)}`,
    async sync({ lastSyncTime }) {
      validate();
      const issues = new Map<string, WorkIssue>();
      const cursors = new Set<string>();
      let nextPageToken: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const result = object(await request('search/jql', {
          jql: buildJiraJql(jql, lastSyncTime), maxResults: pageSize,
          fields: ['summary', 'description', 'status', 'priority', 'assignee', 'project', 'issuetype', 'created', 'updated', 'attachment'],
          ...(nextPageToken ? { nextPageToken } : {})
        }));
        if (!Array.isArray(result.issues)) throw new Error('Jira 查询响应缺少 issues 数组。');
        for (const raw of result.issues) {
          const issue = normalizeJiraIssue(raw, site, priorityMap);
          issues.set(issue.id, issue);
        }
        if (result.isLast === true) return [...issues.values()];
        nextPageToken = text(result.nextPageToken);
        if (!nextPageToken && result.isLast !== false) return [...issues.values()];
        if (!nextPageToken || cursors.has(nextPageToken)) throw new Error('Jira 分页游标缺失或重复；未保存本次同步。');
        cursors.add(nextPageToken);
      }
      throw new Error('Jira 查询超过 JIRA_MAX_PAGES；请缩小 JQL 范围或提高页数上限，本次同步未保存。');
    },
    async attachments(issue) {
      const result = object(await request(`issue/${encodeURIComponent(issue.aid)}?fields=attachment`));
      const values = object(result.fields).attachment;
      if (!Array.isArray(values)) throw new Error('Jira 附件响应格式无效。');
      return attachments(values);
    },
    async assign(issue, accountId) {
      if (!accountId.trim()) throw new Error('Jira 分配需要目标用户 accountId。');
      return request(`issue/${encodeURIComponent(issue.aid)}/assignee`, { accountId }, 'PUT');
    },
    async diagnose() {
      await request('search/jql', { jql: buildJiraJql(jql), maxResults: 1, fields: ['summary'] });
      return [{ name: 'jiraSearch', ok: true, status: 200, message: 'Jira 认证与 JQL 查询成功。' }];
    },
    async downloadAttachment(value, maxBytes) {
      validate();
      const url = new URL(value);
      const trusted = [new URL(root), new URL(site)];
      if (url.protocol !== 'https:' || url.username || url.password || !trusted.some(base => url.origin === base.origin && url.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/rest/api/3/attachment/content/`))) {
        throw new Error('Jira 附件地址不属于已配置服务的附件接口。');
      }
      // Redirects to signed CDN URLs carry no Authorization header.
      let current = url, response: Response | undefined;
      for (let i = 0; i < 5; i++) {
        response = await fetcher(current, {
          headers: i === 0 ? { Authorization: authorization } : {},
          redirect: 'manual', signal: AbortSignal.timeout(timeout)
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('Jira 附件重定向缺少地址。');
        current = new URL(location, current);
        if (current.protocol !== 'https:' || current.username || current.password) throw new Error('Jira 附件重定向地址无效。');
      }
      if (!response?.ok || !response.body) throw new Error('Jira 附件下载失败。');
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body.cancel(); throw new Error('Jira 附件超过大小限制。'); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          size += chunk.byteLength;
          if (size > maxBytes) throw new Error('Jira 附件超过大小限制。');
          chunks.push(chunk);
        }
      } finally { await reader.cancel(); }
      return Buffer.concat(chunks);
    }
  };
};
