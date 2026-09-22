import path from 'node:path';
import os from 'node:os';
import type { Environment } from '../issueSources/types.js';
import type { DecodedHistoryRow, HistoryAdapter, HistoryEntry, HistoryImage, JsonObject } from './types.js';

const record = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const optionalText = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const text = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value ?? '') ?? '';
// Remove only known context envelopes; keep actual user text outside them.
export function cleanUserContext(value: unknown) {
  let result = text(value);
  for (const tag of ['recommended_plugins', 'environment_context', 'permissions instructions', 'skills_instructions', 'app-context']) {
    result = result.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '');
  }
  if (/^# AGENTS\.md instructions for [^\n]+\n/.test(result.trim()) && /<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>/.test(result)) {
    result = result.replace(/^\s*# AGENTS\.md instructions for [^\n]+\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/, '');
  }
  const attachments = result.match(/^\s*# Files mentioned by the user:\s*[\s\S]*?^## My request:\s*\n/m);
  if (attachments?.index === 0) result = result.slice(attachments[0].length);
  result = result
    .replace(/^\s*<image name=\[Image #\d+\] path="[^"\r\n]+">\s*$/gm, '')
    .replace(/^\s*<\/image>\s*$/gm, '');
  return result.trim();
}
const blocksText = (content: unknown) => typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
  .map((value) => record(value)).map((block) => typeof block.type === 'string' && ['text', 'input_text', 'output_text'].includes(block.type) ? block.text : '').filter(Boolean).join('\n');
export function imageAttachments(content: unknown): HistoryImage[] {
  return (Array.isArray(content) ? content : []).map(value => record(value)).filter(block => typeof block.type === 'string' && ['image', 'input_image'].includes(block.type)).map(block => {
    const source = record(block.source);
    const imageUrl = record(block.image_url);
    const url = typeof block.image_url === 'string' ? block.image_url : imageUrl.url;
    const data = source?.type === 'base64' ? `data:${source.media_type};base64,${source.data}` : url;
    // Only embedded raster data is rendered. No arbitrary remote fetches or SVG.
    if (typeof data === 'string' && data.length <= 16 * 1024 * 1024 && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(data)) return { dataUrl: data, alt: '会话图片' };
    return { unavailable: true, alt: '图片未保存为可预览数据，或超过 12 MiB' };
  });
}
const entry = (role: string, content: unknown, timestamp: unknown, extra: Partial<HistoryEntry> = {}): HistoryEntry => {
  const value = role === 'user' ? cleanUserContext(text(content)) : text(content);
  return { role, text: value.length > 24000 ? value.slice(0, 24000) + '\n[内容超过 24,000 字符，已截断]' : value, images: [], ...(typeof timestamp === 'string' ? { timestamp } : {}), ...extra };
};
const messageEntry = (role: string, content: unknown, timestamp: unknown) => entry(role, blocksText(content), timestamp, { images: imageAttachments(content) });

// Each adapter returns metadata patches and normalized entries; storage, tenancy,
// pagination and HTTP/UI stay independent of the agent's on-disk schema.
export const codexHistoryAdapter: HistoryAdapter = {
  id: 'codex', label: 'Codex',
  roots(env: Environment, tenantId: string) {
    const home = env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
    return env.IDE_HISTORY_CODEX_DIR ? [env.IDE_HISTORY_CODEX_DIR] : tenantId === 'default' ? [path.join(home, 'sessions'), path.join(home, 'archived_sessions')] : [];
  },
  decode(row: JsonObject) {
    const p = record(row.payload), timestamp = row.timestamp;
    if (row.type === 'session_meta') return { id: p.id, cwd: p.cwd, createdAt: p.timestamp || timestamp, branch: record(p.git).branch };
    if (row.type === 'turn_context') return { cwd: p.cwd, model: p.model };
    if (row.type === 'event_msg') {
      if (p.type === 'thread_name_updated') return { title: p.thread_name };
      if (p.type === 'task_started') return { status: 'unknown' };
      if (p.type === 'task_complete') return { status: 'completed' };
      if (p.type === 'turn_aborted') return { status: 'interrupted' };
      if (typeof p.type === 'string' && ['user_message', 'agent_message'].includes(p.type)) return { fallback: true, entries: [entry(p.type === 'user_message' ? 'user' : 'assistant', p.message, timestamp)] };
    }
    if (row.type !== 'response_item') return {};
    if (p.type === 'message' && typeof p.role === 'string' && ['user', 'assistant'].includes(p.role)) return { entries: [messageEntry(p.role, p.content, timestamp)] };
    if (typeof p.type === 'string' && ['function_call', 'custom_tool_call'].includes(p.type)) return { entries: [entry('tool_call', p.arguments ?? p.input, timestamp, { name: optionalText(p.name), callId: optionalText(p.call_id) })] };
    if (typeof p.type === 'string' && ['function_call_output', 'custom_tool_call_output'].includes(p.type)) return { entries: [entry('tool_result', p.output, timestamp, { callId: optionalText(p.call_id) })] };
    return {};
  }
};

export const claudeHistoryAdapter: HistoryAdapter = {
  id: 'claude', label: 'Claude Code',
  roots(env: Environment, tenantId: string) {
    return env.IDE_HISTORY_CLAUDE_DIR ? [env.IDE_HISTORY_CLAUDE_DIR] : tenantId === 'default' ? [path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude'), 'projects')] : [];
  },
  decode(row: JsonObject): DecodedHistoryRow {
    // Sub-agent files are indexed independently by their own file identity.
    const message = record(row.message);
    const result: DecodedHistoryRow = { id: row.sessionId, cwd: row.cwd, branch: row.gitBranch, model: message.model };
    if (row.type === 'custom-title') result.title = row.customTitle;
    if (row.type === 'summary') result.title = row.summary;
    if (typeof row.type !== 'string' || !['user', 'assistant'].includes(row.type)) return result;
    const m = message;
    result.status = row.isApiErrorMessage ? 'error' : row.type === 'assistant' && typeof m.stop_reason === 'string' && ['end_turn', 'stop_sequence'].includes(m.stop_reason) ? 'completed' : 'unknown';
    result.entries = [];
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
    for (const value of content) {
      const block = record(value);
      if (block.type === 'tool_use') result.entries.push(entry('tool_call', block.input, row.timestamp, { name: optionalText(block.name), callId: optionalText(block.id) }));
      else if (block.type === 'tool_result') result.entries.push(entry('tool_result', blocksText(block.content), row.timestamp, { callId: optionalText(block.tool_use_id) }));
      else if (typeof block.type === 'string' && ['text', 'image'].includes(block.type)) result.entries.push(messageEntry(row.type, [block], row.timestamp));
    }
    return result;
  }
};

export const defaultHistoryAdapters = [codexHistoryAdapter, claudeHistoryAdapter];
