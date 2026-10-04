/** Recognize protocol containers only; prose, code and JSON inside text blocks stay literal. */
export interface ContextContentEntry { role: string; text: string }
export type ContextContentPart =
  | { type: 'text'; text: string; format?: 'json' }
  | { type: 'image'; value: Record<string, unknown> }
  | { type: 'attachment'; value: Record<string, unknown> };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const textTypes = new Set(['text', 'input_text', 'output_text']);
const imageTypes = new Set(['image', 'input_image', 'image_reference']);
const privateTypes = new Set(['thinking', 'redacted_thinking', 'reasoning']);
const toolCalls = new Set(['tool_use', 'function_call', 'custom_tool_call']);
const toolResults = new Set(['tool_result', 'function_call_output', 'custom_tool_call_output']);
const executionTools = new Set(['mcpToolCall', 'commandExecution', 'fileChange', 'webSearch']);
export function isContextBlock(value: unknown): boolean {
  const item = object(value), type = String(item.type);
  return (textTypes.has(type) && typeof item.text === 'string') || imageTypes.has(type) || privateTypes.has(type)
    || toolCalls.has(type) || toolResults.has(type) || type === 'attachment_reference' || executionTools.has(type)
    || ['tool_call', 'tool_call_update'].includes(String(item.sessionUpdate));
}
const protocolArray = (value: unknown): value is unknown[] => Array.isArray(value) && value.length > 0 && value.every(isContextBlock);
const mcpContent = (value: unknown): value is unknown[] => Array.isArray(value) && value.every(isContextBlock);
export function decodeContextContent(entry: ContextContentEntry): unknown {
  try {
    const value: unknown = JSON.parse(entry.text);
    if (protocolArray(value) || (['tool_call', 'tool_result'].includes(entry.role) && isContextBlock(value))) return value;
  } catch { /* Literal text. */ }
  return entry.text;
}
/** A tool result may wrap MCP content blocks, but arbitrary nested JSON is not protocol. */
export function decodeToolContent(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value), item = object(parsed);
    if (protocolArray(parsed) || isContextBlock(parsed) || mcpContent(item.content)) return parsed;
  } catch { /* Tool output text. */ }
  return value;
}
export function contextContentParts(entry: ContextContentEntry): ContextContentPart[] {
  const parts: ContextContentPart[] = [];
  const literal = (value: unknown, format?: 'json') => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (text) parts.push({ type: 'text', text, ...(format ? { format } : {}) });
  };
  const visit = (value: unknown, toolOutput = false): void => {
    if (toolOutput) value = decodeToolContent(value);
    if (typeof value === 'string') { literal(value); return; }
    if (Array.isArray(value)) { for (const block of value) visit(block, toolOutput); return; }
    const item = object(value), type = String(item.type);
    if (privateTypes.has(type)) return;
    if (textTypes.has(type) && typeof item.text === 'string') { literal(item.text); return; }
    if (imageTypes.has(type)) { parts.push({ type: 'image', value: item }); return; }
    if (type === 'attachment_reference') { parts.push({ type: 'attachment', value: item }); return; }
    if (toolCalls.has(type)) {
      const id = item.call_id ?? item.id;
      literal([item.name && `工具：${item.name}`, id && `调用 ID：${id}`].filter(Boolean).join(' · '));
      literal(item.arguments ?? item.input, typeof (item.arguments ?? item.input) === 'string' ? undefined : 'json');
      return;
    }
    if (toolResults.has(type)) {
      const id = item.call_id ?? item.tool_use_id;
      literal([id && `调用 ID：${id}`, item.is_error === true && '工具报告失败'].filter(Boolean).join(' · '));
      visit(item.output ?? item.content, true); return;
    }
    if (['tool_call', 'tool_call_update'].includes(String(item.sessionUpdate))) {
      literal([item.title, item.toolCallId && `调用 ID：${item.toolCallId}`, item.status].filter(Boolean).join(' · '));
      if (item.rawInput !== undefined) literal(item.rawInput, 'json');
      for (const block of Array.isArray(item.content) ? item.content : []) {
        const content = object(block);
        if (content.type === 'content') visit(content.content, true); else literal(block, 'json');
      }
      if (item.rawOutput !== undefined) visit(item.rawOutput, true);
      return;
    }
    if (executionTools.has(type)) {
      literal([item.tool ?? item.command ?? type, item.id && `调用 ID：${item.id}`, item.status].filter(Boolean).join(' · '));
      if (item.arguments !== undefined) literal(item.arguments, 'json');
      if (item.result !== undefined) visit(item.result, true);
      if (item.error !== undefined && item.error !== null) literal(item.error, 'json');
      if (item.aggregatedOutput !== undefined) literal(item.aggregatedOutput);
      if (item.exitCode !== undefined && item.exitCode !== null) literal(`退出码：${String(item.exitCode)}`);
      if (item.changes !== undefined) literal(item.changes, 'json');
      if (item.action !== undefined) literal(item.action, 'json');
      return;
    }
    if (toolOutput && mcpContent(item.content)) {
      if (item.isError === true) literal('工具报告失败');
      visit(item.content, true);
      if (item.structuredContent !== undefined) literal(item.structuredContent, 'json');
      return;
    }
    literal(value, 'json');
  };
  visit(decodeContextContent(entry), entry.role === 'tool_result');
  return parts;
}
export function contextEntryText(entry: ContextContentEntry): string {
  return contextContentParts(entry).map(part => part.type === 'text' ? part.text : part.type === 'image'
    ? `[图片${part.value.unavailable ? '不可用' : ''}]`
    : `附件：${String(part.value.name || '')} ${String(part.value.path || '')}（仅保留引用，文件未复制）`).join('\n');
}

export interface ContextTextRecord { index: number; role: string; text: string; truncated: boolean }
/** Prefer recent complete turns. Oversized turns retain the latest user correction and result excerpts. */
export function selectContextRecords(entries: Array<ContextContentEntry & { turnId?: string }>, budget: number, perRecord = 12000): ContextTextRecord[] {
  const groups: ContextTextRecord[][] = [];
  let group: ContextTextRecord[] = [], lastTurn: string | undefined;
  for (const [index, entry] of entries.entries()) {
    if ((entry.turnId && lastTurn && entry.turnId !== lastTurn) || (entry.role === 'user' && group.length)) { groups.push(group); group = []; }
    lastTurn = entry.turnId ?? lastTurn;
    const full = contextEntryText(entry);
    if (!full) continue;
    const truncated = full.length > perRecord;
    const text = truncated ? `${full.slice(0, Math.floor(perRecord / 3))}\n[本条中段未纳入，请核对完整记录]\n${full.slice(-Math.floor(perRecord * 2 / 3) + 40)}` : full;
    group.push({ index: index + 1, role: entry.role, text, truncated });
  }
  if (group.length) groups.push(group);
  const selected = new Map<number, ContextTextRecord>();
  let used = 0;
  const add = (entry: ContextTextRecord) => {
    const size = entry.text.length + 100;
    if (selected.has(entry.index) || used + size > budget) return;
    selected.set(entry.index, entry); used += size;
  };
  for (const turn of groups.reverse()) {
    if (turn.reduce((sum, entry) => sum + entry.text.length + 100, 0) <= budget - used) { turn.forEach(add); continue; }
    const user = turn.find(entry => entry.role === 'user');
    if (user) add(user);
    [...turn].reverse().forEach(add);
  }
  return [...selected.values()].sort((a, b) => a.index - b.index);
}
