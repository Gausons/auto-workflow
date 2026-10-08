import { contextEntryText, decodeContextContent, type ContextContentEntry, type ContextTextRecord } from './contextContent.js';

export interface HandoffEntry extends ContextContentEntry {
  source?: string; turnId?: string; callId?: string; phase?: 'commentary' | 'final';
}
export interface HandoffRecord extends ContextTextRecord { reasons: string[] }
export interface RequirementExcerpt { record: number; text: string }
export const contextPolicyVersion = 'handoff-selection-v1';
const requirement = /约束|必须|不得|不能|不要|禁止|保持|兼容|验收|只(?:做|改|处理|允许)|不(?:新增|修改|改变|引入|需要)|改为|改成|采用|选择|否决|放弃|\b(?:must|never|do not|don't|keep|without|acceptance|constraint)\b/i;
const failure = /失败|错误|未通过|待核对|未完成|阻塞|FAIL|ERROR|exit code[:： ]+[1-9]|退出码[:： ]+[1-9]/i;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Preserve candidate wording, including negation. Rules do not decide whether a requirement was superseded. */
export function contextRequirements(entries: HandoffEntry[]): RequirementExcerpt[] {
  return entries.flatMap((entry, index) => entry.role === 'user'
    ? contextEntryText(entry).split(/(?<=[。！？\n])|\r?\n/).filter(text => requirement.test(text)).map(text => ({ record: index + 1, text: text.trim() })).filter(item => item.text)
    : []);
}

export function requirementExcerpt(text: string, limit: number): string {
  return contextExcerpt(text, limit, [requirement.exec(text)?.[0]?.toLowerCase() || '约束']);
}

export function contextToolIdentity(entry: HandoffEntry): string | undefined {
  if (!['tool_call', 'tool_result'].includes(entry.role)) return;
  if (entry.callId) return entry.callId;
  const decoded = decodeContextContent(entry);
  const blocks = Array.isArray(decoded) ? decoded : [decoded];
  for (const block of blocks) {
    const value = object(block);
    const id = value.call_id ?? value.tool_use_id ?? value.toolCallId ?? value.id;
    if (typeof id === 'string') return id;
  }
}

export function contextExcerpt(text: string, limit: number, terms: string[] = []): string {
  if (text.length <= limit) return text;
  const marker = '\n[节选；其余见完整原文]\n';
  const available = Math.max(0, limit - marker.length);
  const lower = text.toLowerCase();
  const position = terms.map(term => lower.indexOf(term)).find(index => index >= 0);
  if (position !== undefined) {
    const start = Math.max(0, Math.min(position - Math.floor(available / 4), text.length - available));
    return text.slice(start, start + available) + marker;
  }
  const head = Math.floor(available / 3);
  return text.slice(0, head) + marker + text.slice(text.length - (available - head));
}

function intentTerms(message: string): string[] {
  const cleaned = message.toLowerCase().replace(/继续|刚才|上面|之前|一下|帮我|请|按照|处理|这个|那个|进行|检查|修复/g, ' ');
  const terms = cleaned.match(/[a-z0-9_./-]{3,}|[\u4e00-\u9fff]{2,}/g) || [];
  const result = new Set<string>();
  for (const term of terms) {
    if (/^[\u4e00-\u9fff]+$/.test(term)) {
      for (let i = 0; i < term.length - 1; i++) result.add(term.slice(i, i + 2));
    } else result.add(term);
  }
  if (/方案|plan|option/i.test(message)) result.add('方案');
  return [...result].slice(0, 80);
}

/** Select evidence units, keeping matching tool calls/results together within their source and turn. */
export function selectHandoffRecords(entries: HandoffEntry[], budget: number, perRecord = 6000, message = ''): HandoffRecord[] {
  if (budget < 180) return [];
  const terms = intentTerms(message);
  const requirements = contextRequirements(entries);
  const required = new Set(requirements.map(item => item.record));
  const requirementsByRecord = new Map<number, string[]>();
  for (const item of requirements) requirementsByRecord.set(item.record, [...(requirementsByRecord.get(item.record) || []), requirement.exec(item.text)?.[0]?.toLowerCase() || '约束']);
  const texts = entries.map(contextEntryText);
  const users = entries.flatMap((entry, index) => entry.role === 'user' ? [index] : []);
  const latestUser = users.at(-1), firstUser = users[0];
  const lastFailure = entries.findLastIndex((entry, index) => entry.role === 'tool_result' && failure.test(texts[index]!));
  const units = new Map<string, { indexes: number[]; score: number; reasons: Set<string> }>();
  let turn = 0;
  for (const [index, entry] of entries.entries()) {
    if (entry.role === 'user') turn++;
    const id = contextToolIdentity(entry);
    const key = id ? JSON.stringify([entry.source || '', entry.turnId || turn, id]) : `record:${index}`;
    const unit = units.get(key) || { indexes: [], score: 0, reasons: new Set<string>() };
    unit.indexes.push(index);
    const matchCount = terms.filter(term => texts[index]!.toLowerCase().includes(term)).length;
    let score = entry.phase === 'commentary' ? 5 : 20;
    const add = (value: number, reason: string) => { score = Math.max(score, value); unit.reasons.add(reason); };
    if (index === latestUser) add(130, '最近用户要求');
    if (index === lastFailure) add(135, '最近失败线索，需核对工具证据');
    if (required.has(index + 1)) add(110, '用户要求候选，需核对是否已修正');
    if (matchCount) add(115 + Math.min(matchCount, 10), '本轮关联');
    if (entry.role === 'reference' || /^(task|execution):/.test(entry.source || '')) add(105, '任务或执行参考');
    if (index === firstUser) add(100, '原始目标参考');
    if (entry.role === 'tool_result') add(50, '工具结果');
    if (entry.role === 'assistant' && entry.phase !== 'commentary') add(40, '助手公开回复，未经验证');
    unit.score = Math.max(unit.score, score);
    units.set(key, unit);
  }
  const selected: HandoffRecord[] = [];
  let remaining = budget;
  const ranked = [...units.values()].sort((a, b) => b.score - a.score || b.indexes.at(-1)! - a.indexes.at(-1)!);
  for (const unit of ranked) {
    // Keep the initial input plus the last update; intermediary progress stays in full evidence.
    const indexes = unit.indexes.length > 2 ? [unit.indexes[0]!, unit.indexes.at(-1)!] : unit.indexes;
    const size = Math.min(perRecord, Math.floor((remaining - indexes.length * 100) / indexes.length));
    if (size < 80) continue;
    const candidates = indexes.map(index => {
      const text = contextExcerpt(texts[index]!, size, [...(requirementsByRecord.get(index + 1) || []), ...terms]);
      return { index: index + 1, role: entries[index]!.role, text, truncated: text !== texts[index], reasons: [...unit.reasons] };
    });
    const cost = candidates.reduce((sum, item) => sum + item.text.length + 100, 0);
    if (cost > remaining) continue;
    selected.push(...candidates); remaining -= cost;
  }
  return selected.sort((a, b) => a.index - b.index);
}
