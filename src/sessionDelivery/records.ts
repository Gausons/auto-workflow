import type { Environment } from '../issueSources/types.ts';

type ObjectRecord = Record<string, unknown>;
export const asObject = (value: unknown): ObjectRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectRecord : {};

/** Source records are reference material, never instructions to execute automatically. */
export function deliverRecord(agent: string, value: unknown, environment: Environment) {
  let redactions = 0, exclusions = 0;
  const secrets = Object.entries(environment).filter(([key, val]) => /KEY|SECRET|TOKEN|COOKIE|PASSWORD/.test(key) && val && val.length >= 8).map(([, val]) => val!);
  if (environment.JIRA_EMAIL && environment.JIRA_API_TOKEN) secrets.push(Buffer.from(`${environment.JIRA_EMAIL}:${environment.JIRA_API_TOKEN}`).toString('base64'));
  function cleanText(value: string): string {
    let result = value;
    for (const secret of secrets) {
      if (result.includes(secret)) { redactions++; result = result.split(secret).join('[redacted]'); }
    }
    result = result.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.\-]{8,}/gi, (_all, scheme) => { redactions++; return `${scheme} [redacted]`; });
    result = result.replace(/((?:[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|ACCESS_SECRET|PASSWORD)|SECRET)\s*=\s*)([^\s"']+)/g, (_all, prefix) => { redactions++; return `${prefix}[redacted]`; });
    result = result.replace(/("(?:api[_-]?key|access[_-]?token|secret|password|authorization|cookie)"\s*:\s*")(?:\\.|[^"\\])*(")/gi, (_all, prefix, suffix) => { redactions++; return `${prefix}[redacted]${suffix}`; });
    return result;
  }
  function clean(value: unknown, depth = 0): unknown {
    if (depth > 100) { exclusions++; return '[nested content omitted]'; }
    if (typeof value === 'string') return cleanText(value);
    if (Array.isArray(value)) return value.map(item => clean(item, depth + 1)).filter(item => item !== undefined);
    if (value === null || typeof value !== 'object') return value;
    const record = asObject(value);
    if (['reasoning', 'thinking', 'redacted_thinking', 'agent_reasoning', 'reasoning_summary', 'reasoning_text', 'reasoning_summary_text'].includes(String(record.type)) || ['system', 'developer'].includes(String(record.role)) || (record.role === 'assistant' && record.channel === 'analysis')) { exclusions++; return undefined; }
    const result: ObjectRecord = {};
    for (const [key, item] of Object.entries(record)) {
      if (/^(?:api[_-]?key|access[_-]?token|access[_-]?secret|secret|password|authorization|cookie)$/i.test(key)) { redactions++; result[key] = '[redacted]'; }
      else { const cleaned = clean(item, depth + 1); if (cleaned !== undefined) Object.defineProperty(result, key, { value: cleaned, enumerable: true }); }
    }
    return result;
  }
  const original = asObject(value), payload = asObject(original.payload), message = asObject(original.message);
  const type = String(agent === 'codex' ? payload.type || original.type : original.type || 'unknown');
  const role = String(payload.role || message.role || (['user', 'assistant'].includes(type) ? type : ''));
  const record = clean(value);
  const hidden = record === undefined || (original.payload !== undefined && asObject(record).payload === undefined);
  return {
    kind: hidden ? 'omitted' : /tool_use|function_call$|custom_tool_call$/.test(type) ? 'tool_call' : /tool_result|function_call_output|custom_tool_call_output/.test(type) ? 'tool_result' : role ? 'message' : original.type === 'turn_context' ? 'context' : 'event',
    agent, sourceType: type, role: hidden ? undefined : role || undefined,
    timestamp: typeof original.timestamp === 'string' ? original.timestamp : null,
    record: hidden ? undefined : record, redactions, exclusions,
    ...(hidden ? { reason: 'internal_content' } : {}),
    trust: 'source_reference'
  };
}
