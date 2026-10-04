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
        const add = (role: ContextEvent['role'], value: unknown, target = entries, metadata: Partial<Pick<ContextEvent, 'name' | 'callId' | 'phase'>> = {}) => {
          const clean = role === 'user' ? sanitizeUser(value) : value;
          // Text messages are wrapped once so literal JSON cannot become protocol on a later handoff.
          const content = ['user', 'assistant'].includes(role) && typeof clean === 'string' ? [{ type: 'text', text: clean }] : clean;
          if (typeof clean === 'string' && !clean.trim()) return;
          if (typeof content === 'string' ? !content.trim() : Array.isArray(content) && !content.length) return;
          target.push({ role, text: stringify(content), source: id, line: event.sourceLine,
            ...(typeof row.timestamp === 'string' ? { timestamp: row.timestamp } : {}), turnId, ...metadata });
        };
        if (event.agent === 'codex') {
          if (row.type === 'response_item') {
            if (p.type === 'message' && ['user', 'assistant'].includes(String(p.role))) add(p.role as 'user' | 'assistant', p.content, entries, p.phase === 'commentary' || p.phase === 'final' ? { phase: p.phase } : {});
            const metadata = { ...(typeof p.name === 'string' ? { name: p.name } : {}), ...(typeof p.call_id === 'string' ? { callId: p.call_id } : {}) };
            if (typeof p.type === 'string' && ['function_call', 'custom_tool_call'].includes(p.type)) add('tool_call', p, entries, metadata);
            if (typeof p.type === 'string' && ['function_call_output', 'custom_tool_call_output'].includes(p.type)) add('tool_result', p, entries, metadata);
          } else if (row.type === 'event_msg' && typeof p.type === 'string' && ['user_message', 'agent_message'].includes(p.type)) {
            add(p.type === 'user_message' ? 'user' : 'assistant', p.message, fallback);
          }
        } else if (event.agent === 'claude' && typeof row.type === 'string' && ['user', 'assistant'].includes(row.type)) {
          const content = object(row.message).content;
          if (typeof content === 'string') add(row.type, content);
          else if (Array.isArray(content)) {
            let visible: unknown[] = [];
            const flush = () => { if (visible.length) add(row.type as 'user' | 'assistant', visible); visible = []; };
            for (const value of content) {
              const block = object(value);
              if (block.type === 'tool_use' || block.type === 'tool_result') {
                flush();
                const callId = block.type === 'tool_use' ? block.id : block.tool_use_id;
                add(block.type === 'tool_use' ? 'tool_call' : 'tool_result', block, entries, {
                  ...(typeof block.name === 'string' ? { name: block.name } : {}), ...(typeof callId === 'string' ? { callId } : {})
                });
              } else if (!['thinking', 'redacted_thinking', 'reasoning'].includes(String(block.type))) visible.push(value);
            }
            flush();
          }
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
