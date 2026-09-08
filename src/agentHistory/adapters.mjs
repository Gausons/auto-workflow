import path from 'node:path';
import os from 'node:os';

const text = (value) => typeof value === 'string' ? value : JSON.stringify(value ?? '');
// Remove only known context envelopes; keep actual user text outside them.
export function cleanUserContext(value) {
  let result = value;
  for (const tag of ['recommended_plugins', 'environment_context', 'permissions instructions', 'skills_instructions', 'app-context']) {
    result = result.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '');
  }
  if (/^# AGENTS\.md instructions for [^\n]+\n/.test(result.trim()) && /<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>/.test(result)) {
    result = result.replace(/^\s*# AGENTS\.md instructions for [^\n]+\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/, '');
  }
  return result.trim();
}
const blocksText = (content) => typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
  .map((block) => ['text', 'input_text', 'output_text'].includes(block?.type) ? block.text : '').filter(Boolean).join('\n');
export function imageAttachments(content) {
  return (Array.isArray(content) ? content : []).filter((b) => ['image', 'input_image'].includes(b?.type)).map((b) => {
    const source = b.source;
    const url = typeof b.image_url === 'string' ? b.image_url : b.image_url?.url;
    const data = source?.type === 'base64' ? `data:${source.media_type};base64,${source.data}` : url;
    // Only embedded raster data is rendered. No arbitrary remote fetches or SVG.
    if (typeof data === 'string' && data.length <= 16 * 1024 * 1024 && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(data)) return { dataUrl: data, alt: '会话图片' };
    return { unavailable: true, alt: '图片未保存为可预览数据，或超过 12 MiB' };
  });
}
const entry = (role, content, timestamp, extra = {}) => {
  const value = role === 'user' ? cleanUserContext(text(content)) : text(content);
  return { role, text: value.length > 24000 ? value.slice(0, 24000) + '\n[内容超过 24,000 字符，已截断]' : value, timestamp, ...extra };
};
const messageEntry = (role, content, timestamp) => entry(role, blocksText(content), timestamp, { images: imageAttachments(content) });

// Each adapter returns metadata patches and normalized entries; storage, tenancy,
// pagination and HTTP/UI stay independent of the agent's on-disk schema.
export const codexHistoryAdapter = {
  id: 'codex', label: 'Codex',
  roots(env, tenantId) {
    const home = env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
    return env.IDE_HISTORY_CODEX_DIR ? [env.IDE_HISTORY_CODEX_DIR] : tenantId === 'default' ? [path.join(home, 'sessions'), path.join(home, 'archived_sessions')] : [];
  },
  decode(row) {
    const p = row.payload || {}, timestamp = row.timestamp;
    if (row.type === 'session_meta') return { id: p.id, cwd: p.cwd, createdAt: p.timestamp || timestamp, branch: p.git?.branch };
    if (row.type === 'turn_context') return { cwd: p.cwd, model: p.model };
    if (row.type === 'event_msg') {
      if (p.type === 'thread_name_updated') return { title: p.thread_name };
      if (p.type === 'task_started') return { status: 'unknown' };
      if (p.type === 'task_complete') return { status: 'completed' };
      if (p.type === 'turn_aborted') return { status: 'interrupted' };
      if (['user_message', 'agent_message'].includes(p.type)) return { fallback: true, entries: [entry(p.type === 'user_message' ? 'user' : 'assistant', p.message, timestamp)] };
    }
    if (row.type !== 'response_item') return {};
    if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) return { entries: [messageEntry(p.role, p.content, timestamp)] };
    if (['function_call', 'custom_tool_call'].includes(p.type)) return { entries: [entry('tool_call', p.arguments ?? p.input, timestamp, { name: p.name, callId: p.call_id })] };
    if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) return { entries: [entry('tool_result', p.output, timestamp, { callId: p.call_id })] };
    return {};
  }
};

export const claudeHistoryAdapter = {
  id: 'claude', label: 'Claude Code',
  roots(env, tenantId) {
    return env.IDE_HISTORY_CLAUDE_DIR ? [env.IDE_HISTORY_CLAUDE_DIR] : tenantId === 'default' ? [path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude'), 'projects')] : [];
  },
  decode(row) {
    // Sub-agent files are indexed independently by their own file identity.
    const result = { id: row.sessionId, cwd: row.cwd, branch: row.gitBranch, model: row.message?.model };
    if (row.type === 'custom-title') result.title = row.customTitle;
    if (row.type === 'summary') result.title = row.summary;
    if (!['user', 'assistant'].includes(row.type)) return result;
    const m = row.message || {};
    result.status = row.isApiErrorMessage ? 'error' : row.type === 'assistant' && ['end_turn', 'stop_sequence'].includes(m.stop_reason) ? 'completed' : 'unknown';
    result.entries = [];
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
    for (const block of content) {
      if (block.type === 'tool_use') result.entries.push(entry('tool_call', block.input, row.timestamp, { name: block.name, callId: block.id }));
      else if (block.type === 'tool_result') result.entries.push(entry('tool_result', blocksText(block.content), row.timestamp, { callId: block.tool_use_id }));
      else if (['text', 'image'].includes(block.type)) result.entries.push(messageEntry(row.type, [block], row.timestamp));
    }
    return result;
  }
};

export const defaultHistoryAdapters = [codexHistoryAdapter, claudeHistoryAdapter];
