import { createHash } from 'node:crypto';
import type { SourceAdapter } from '@auto-workflow/context-engine';

export interface IssueRecord {
  id: string;
  source: string;
  code: string;
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  updatedAt?: string;
  sourceUrl?: string;
  attachments?: Array<{ name: string; url: string; contentType?: string; size?: number }>;
}

/** Wraps an authorized issue lookup. Assignment and workflow mutations stay with the issue provider. */
export function issueRecordSource(resolve: (id: string) => Promise<IssueRecord | null>, clean: (text: string) => string = text => text): SourceAdapter<string> {
  return { id: 'issue', async capture(id) {
    if (!id || id.length > 256) throw new Error('问题来源标识无效');
    const issue = await resolve(id);
    if (!issue || issue.id !== id || !issue.source || !issue.title || issue.title.length > 12000 ||
        (issue.description?.length || 0) > 1_000_000 || (issue.attachments?.length || 0) > 1000) throw new Error('问题来源不存在、已变化或超出大小限制');
    const source = `issue:${createHash('sha256').update(issue.source).update('\0').update(issue.id).update('\0').update(issue.updatedAt || '').digest('hex')}`;
    const summary = { code: issue.code, title: clean(issue.title), description: clean(issue.description || ''),
      status: issue.status || '', priority: issue.priority || '', updatedAt: issue.updatedAt || '', sourceUrl: clean(issue.sourceUrl || '') };
    const events = [{ role: 'reference', text: JSON.stringify(summary), source },
      ...(issue.attachments || []).map(item => ({ role: 'reference', text: JSON.stringify({ attachment: { name: clean(item.name), url: clean(item.url),
        contentType: item.contentType || '', size: item.size ?? null, availability: 'reference_only' } }), source }))];
    return { events, sources: [source], partial: Boolean(issue.attachments?.length) };
  } };
}
