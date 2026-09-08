import { createJiraSource } from './jira.ts';
import type { Environment, IssueSource, IssueSourceFactory, SourceContext } from './types.ts';
export type * from './types.ts';

interface SourceRegistration {
  create: IssueSourceFactory;
  configure?: (context: SourceContext, patch?: Record<string, unknown>) => Record<string, unknown>;
  environmentPrefixes?: readonly string[];
}
const registry = new Map<string, SourceRegistration>([['jira', { create: createJiraSource }]]);
let defaultProvider = 'jira';

/** Preloaded local extensions register factories only; tenant credentials stay in each context. */
export function registerIssueSource(id: string, registration: SourceRegistration, options: { default?: boolean } = {}): void {
  if (!/^[a-z][a-z0-9-]*$/.test(id) || registry.has(id)) throw new Error('数据源名称无效或已注册。');
  registry.set(id, registration);
  if (options.default) defaultProvider = id;
}

export function issueSourceId(environment: Environment): string {
  return (environment.ISSUE_PROVIDER || defaultProvider).trim().toLowerCase();
}

export function issueSourceConfig(context: SourceContext, patch?: Record<string, unknown>): Record<string, unknown> {
  return registry.get(issueSourceId(context.environment))?.configure?.(context, patch) || {};
}

export function sourceEnvironmentPrefixes(): string[] {
  return [...registry.values()].flatMap(entry => [...(entry.environmentPrefixes || [])]);
}

export function createIssueSource(context: SourceContext, providers?: Readonly<Record<string, IssueSourceFactory>>): IssueSource {
  const id = issueSourceId(context.environment);
  const factory = providers ? (Object.hasOwn(providers, id) ? providers[id] : undefined) : registry.get(id)?.create;
  if (!factory) throw new Error(`不支持的问题数据源：${id}。`);
  return factory(context);
}

export function sourceStorageKey(source: IssueSource, legacyKey: string): string {
  return source.storageScope || legacyKey;
}

export function syncCheckpoint(source: IssueSource, startedAt: Date): string {
  return source.checkpoint?.(startedAt) || startedAt.toISOString();
}
