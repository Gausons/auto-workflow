import { contextEntryText } from '../shared/contextContent.js';
import { contextExcerpt, contextRequirements, requirementExcerpt, selectHandoffRecords, type HandoffEntry } from '../shared/contextSelection.js';

/** A deterministic reading aid, never a replacement for user wording or verification evidence. */
export function contextBrief(entries: HandoffEntry[], message: string, budget = 2200): string {
  const lines = ['## 核心交接单（历史参考）', '要求仅为原文候选，后续修正需结合来源核对；执行结束和助手自述均不代表验收通过。'];
  const texts = entries.map(contextEntryText);
  const users = entries.flatMap((entry, index) => entry.role === 'user' ? [index] : []);
  const requirements = contextRequirements(entries);
  const related = selectHandoffRecords(entries, 5000, 500, message);
  const candidates: Array<{ label: string; index: number; text: string }> = [];
  const add = (label: string, index: number | undefined, text?: string) => {
    if (index !== undefined && index >= 0) candidates.push({ label, index, text: text ?? texts[index]! });
  };
  add('原始目标参考', users[0]);
  add('最近用户要求', users.at(-1));
  add('最近执行检查点', entries.findLastIndex(entry => Boolean(entry.source?.startsWith('execution:'))));
  const latestTool = related.find(record => record.reasons.includes('最近失败线索，需核对工具证据')) || related.findLast(record => record.role === 'tool_result');
  if (latestTool) add('工具证据线索（代码版本需另核对）', latestTool.index - 1, latestTool.text);
  for (const item of requirements.slice(-4)) add('用户要求候选', item.record - 1, item.text);
  for (const item of related.filter(record => record.reasons.includes('本轮关联')).slice(-3)) add('本轮相关原文', item.index - 1, item.text);
  add('任务参考', entries.findLastIndex(entry => Boolean(entry.source?.startsWith('task:'))));
  add('最近助手回复（未经验证，可能含下一步建议）', entries.findLastIndex(entry => entry.role === 'assistant' && entry.phase !== 'commentary'));
  let omitted = 0;
  const seen = new Set<string>();
  for (const item of candidates) {
    const key = JSON.stringify([item.index, item.text]);
    if (seen.has(key)) continue;
    seen.add(key);
    const line = `\n${item.label}（记录 ${item.index + 1}）：${(item.label === '用户要求候选' ? requirementExcerpt(item.text, 220) : contextExcerpt(item.text, 220)).replace(/\s+/g, ' ')}`;
    if (lines.join('\n').length + line.length + 150 <= budget) lines.push(line);
    else omitted++;
  }
  const remainingRequirements = Math.max(0, requirements.length - 4);
  lines.push(`\n${omitted || remainingRequirements ? `另有 ${remainingRequirements} 项要求候选及 ${omitted} 项摘录未在此展开，请读取交接文件中的要求索引。` : '详细依据见交接文件及完整原文。'}代码与普通附件未复制；没有证据的验证结果为未知。`);
  return lines.join('\n');
}
