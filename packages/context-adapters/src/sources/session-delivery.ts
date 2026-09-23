import type { CaptureResult, ContextEvent, SourceAdapter } from '@auto-workflow/context-engine';

interface DeliveryEvent { kind: string; href?: string; sourceLine?: number; agent?: string; record?: unknown }
interface DeliveryPage { coverage: { pendingBytes: number }; events: Array<DeliveryEvent | null>; nextCursor?: string | null }
export interface SessionDelivery {
  detail(id: string, params?: URLSearchParams): Promise<unknown>;
  record(id: string, params?: URLSearchParams): Promise<unknown>;
}
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const stringify = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value ?? '') ?? '';

/** The only adapter that understands Codex/Claude delivery rows. */
export function sessionDeliverySource(delivery: SessionDelivery, sanitizeUser: (value: unknown) => unknown): SourceAdapter<string> {
  return { id: 'agent-session', async capture(id): Promise<CaptureResult> {
    const entries: ContextEvent[] = [], fallback: ContextEvent[] = [];
    let cursor: string | null = null, partial = false, turnId: string | undefined;
    do {
      const page = await delivery.detail(id, new URLSearchParams({ limit: '200', ...(cursor ? { cursor } : {}) })) as DeliveryPage;
      partial ||= page.coverage.pendingBytes > 0;
      for (let event of page.events) {
        if (!event) { partial = true; continue; }
        if (event.kind === 'reference') {
          const ref = new URL(event.href || '', 'http://localhost').searchParams.get('ref');
          const resolved = (await delivery.record(id, new URLSearchParams({ ref: ref || '' })) as { event?: DeliveryEvent | null }).event;
          if (!resolved) { partial = true; continue; }
          event = resolved;
        }
        if (event.kind === 'unavailable') { partial = true; continue; }
        if (!event.record || event.kind === 'omitted') continue;
        const row = object(event.record), p = object(row.payload);
        if (typeof p.turn_id === 'string') turnId = p.turn_id;
        const add = (role: ContextEvent['role'], value: unknown, target = entries) => {
          const content = role === 'user' ? sanitizeUser(value) : value;
          if (typeof content === 'string' ? !content.trim() : Array.isArray(content) && !content.length) return;
          target.push({ role, text: stringify(content), source: id, line: event.sourceLine,
            ...(typeof row.timestamp === 'string' ? { timestamp: row.timestamp } : {}), turnId });
        };
        if (event.agent === 'codex') {
          if (row.type === 'response_item') {
            if (p.type === 'message' && ['user', 'assistant'].includes(String(p.role))) add(p.role as 'user' | 'assistant', p.content);
            if (typeof p.type === 'string' && ['function_call', 'custom_tool_call'].includes(p.type)) add('tool_call', p);
            if (typeof p.type === 'string' && ['function_call_output', 'custom_tool_call_output'].includes(p.type)) add('tool_result', p);
          } else if (row.type === 'event_msg' && typeof p.type === 'string' && ['user_message', 'agent_message'].includes(p.type)) {
            add(p.type === 'user_message' ? 'user' : 'assistant', p.message, fallback);
          }
        } else if (event.agent === 'claude' && typeof row.type === 'string' && ['user', 'assistant'].includes(row.type)) {
          add(row.type as 'user' | 'assistant', object(row.message).content ?? row.message);
        }
      }
      cursor = page.nextCursor ?? null;
    } while (cursor);
    // Event mirrors are deduplicated by occurrence, preserving genuinely repeated turns.
    const key = (entry: ContextEvent) => {
      let text = entry.text;
      try { const blocks = JSON.parse(text); if (Array.isArray(blocks)) text = blocks.filter(b => ['text', 'input_text', 'output_text'].includes(b.type)).map(b => b.text || '').join('\n'); } catch { /* Plain text. */ }
      return JSON.stringify([entry.turnId || '', entry.role, text]);
    };
    const mirrors = new Map<string, number>();
    for (const entry of entries) if (['user', 'assistant'].includes(entry.role)) mirrors.set(key(entry), (mirrors.get(key(entry)) || 0) + 1);
    for (const entry of fallback) {
      const k = key(entry), count = mirrors.get(k) || 0;
      if (count) mirrors.set(k, count - 1); else entries.push(entry);
    }
    entries.sort((a, b) => (a.line || 0) - (b.line || 0));
    return { events: entries, sources: [id], partial };
  } };
}
