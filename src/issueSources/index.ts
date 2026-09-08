import { createPmSource } from './pm.ts';
import { createJiraSource } from './jira.ts';
import type { IssueSource, IssueSourceFactory, SourceContext } from './types.ts';
export type * from './types.ts';

/** Registry is explicit and local; no global tenant credentials or mutable singleton clients. */
export function createIssueSource(context: SourceContext, providers: Readonly<Record<string, IssueSourceFactory>> = { pm: createPmSource, jira: createJiraSource }): IssueSource {
  const id = (context.environment.ISSUE_PROVIDER || 'pm').trim().toLowerCase();
  if (!Object.hasOwn(providers, id)) throw new Error(`不支持的问题数据源：${id}。`);
  return providers[id]!(context);
}

export function sourceStorageKey(source: IssueSource, legacyKey: string): string {
  return source.storageScope ? source.storageScope : legacyKey;
}

export function syncCheckpoint(source: IssueSource, startedAt: Date): string {
  if (source.id !== 'pm') return startedAt.toISOString();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())} ${pad(startedAt.getHours())}:${pad(startedAt.getMinutes())}:${pad(startedAt.getSeconds())}`;
}
