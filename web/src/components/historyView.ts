// Restricted Markdown renderer; attachments are validated separately from message text.
import type { HistoryMessage } from '../../../shared/taskTypes.js';
type HistoryImage = NonNullable<HistoryMessage['images']>[number];
const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escape = (text: unknown) => String(text ?? '').replace(/[&<>"']/g, (c) => entities[c] || c);
function inline(text: string) {
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let output = '', offset = 0;
  for (const match of text.matchAll(pattern)) {
    output += escape(text.slice(offset, match.index));
    output += match[1] ? `<code>${escape(match[1])}</code>` : match[2] ? `<strong>${escape(match[2])}</strong>` : `<a href="${escape(match[4])}" target="_blank" rel="noopener noreferrer">${escape(match[3])}</a>`;
    offset = match.index + match[0].length;
  }
  return output + escape(text.slice(offset));
}
function tableCells(line: string): string[] | null {
  const text = line.trim();
  const cells: string[] = [];
  let cell = '', code = false, separators = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\' && text[index + 1] === '|') { cell += '|'; index += 1; continue; }
    if (character === '`') code = !code;
    if (character === '|' && !code) { cells.push(cell.trim()); cell = ''; separators += 1; }
    else cell += character;
  }
  if (!separators) return null;
  cells.push(cell.trim());
  if (text.startsWith('|')) cells.shift();
  if (text.endsWith('|') && cells.at(-1) === '') cells.pop();
  return cells.length ? cells : null;
}
function tableAlignments(line: string): Array<'left' | 'center' | 'right'> | null {
  const cells = tableCells(line);
  if (!cells || !cells.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
  return cells.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
}
export function renderMarkdown(text: unknown) {
  const lines = String(text ?? '').split(/\r?\n/);
  let html = '', paragraph: string[] = [], list: 'ul' | 'ol' | null = null, fence: string | null = null, code: string[] = [];
  const flush = () => { if (paragraph.length) { html += `<p>${paragraph.map(inline).join('<br>')}</p>`; paragraph = []; } if (list) { html += `</${list}>`; list = null; } };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      if (fence !== null) { html += `<div class="history-code"><span>${escape(fence || '代码')}</span><pre><code>${escape(code.join('\n'))}</code></pre></div>`; fence = null; code = []; }
      else { flush(); fence = line.trim().slice(3); }
      continue;
    }
    if (fence !== null) { code.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    const headers = tableCells(line);
    const alignments = index + 1 < lines.length ? tableAlignments(lines[index + 1]) : null;
    if (headers && alignments && headers.length === alignments.length) {
      flush();
      const row = (cells: string[], tag: 'th' | 'td') => `<tr>${headers.map((_, column) => `<${tag}${tag === 'th' ? ' scope="col"' : ''} class="history-table-align-${alignments[column]}">${inline(cells[column] || '')}</${tag}>`).join('')}</tr>`;
      html += `<div class="history-table"><table><thead>${row(headers, 'th')}</thead><tbody>`;
      index += 1;
      while (index + 1 < lines.length) {
        const cells = tableCells(lines[index + 1]);
        if (!cells || !lines[index + 1].trim()) break;
        html += row(cells, 'td');
        index += 1;
      }
      html += '</tbody></table></div>';
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { flush(); const level = Math.min(heading[1].length + 2, 6); html += `<h${level}>${inline(heading[2])}</h${level}>`; continue; }
    const item = /^\s*(?:([-*])|\d+\.)\s+(.+)$/.exec(line);
    if (item) {
      const type = item[1] ? 'ul' : 'ol';
      if (paragraph.length || (list && list !== type)) flush();
      if (!list) { html += `<${type}>`; list = type; }
      html += `<li>${inline(item[2])}</li>`; continue;
    }
    if (list) flush();
    if (/^---+$/.test(line.trim())) { flush(); html += '<hr>'; continue; }
    paragraph.push(line);
  }
  flush();
  if (fence !== null) html += `<div class="history-code"><span>${escape(fence || '代码')}</span><pre><code>${escape(code.join('\n'))}</code></pre></div>`;
  return html;
}
export function renderImages(images: HistoryImage[] = []) {
  if (!images.length) return '';
  return `<div class="history-images">${images.map((image: HistoryImage) => {
    const valid = typeof image.dataUrl === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(image.dataUrl);
    return valid ? `<figure><img src="${escape(image.dataUrl)}" alt="${escape(image.alt || '会话图片')}" loading="lazy" decoding="async"><figcaption>会话图片</figcaption></figure>` : `<p class="history-image-unavailable">${escape(image.alt || '图片无法预览')}</p>`;
  }).join('')}</div>`;
}
export function renderMessages(messages: HistoryMessage[], images = (message: HistoryMessage) => renderImages(message.images)) {
  let html = '', work: HistoryMessage[] = [];
  function flushWork() {
    if (!work.length) return;
    const calls = work.filter(m => m.role === 'tool_call');
    const label = calls.length ? `使用了 ${calls.length} 次工具` : work.some(m => m.role === 'assistant') ? '查看工作过程' : '工具输出';
    html += `<details class="history-work"><summary><span class="history-work-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="m7 8 4 4-4 4m6 0h4"/></svg></span><strong>${label}</strong><span class="history-chevron" aria-hidden="true">›</span></summary><div class="history-work-body">`;
    for (const m of work) {
      html += m.role === 'assistant'
        ? `<div class="history-work-commentary history-markdown">${renderMarkdown(m.text)}${images(m)}${renderMessageTime(m.timestamp)}</div>`
        : `<details class="history-tool"><summary>${escape(m.role === 'tool_call' ? m.name || '工具调用' : '工具结果')}<span>${escape(m.callId || '')}</span></summary>${renderMessageTime(m.timestamp)}<pre>${escape(m.text)}</pre>${images(m)}</details>`;
    }
    html += '</div></details>'; work = [];
  }
  for (const m of messages) {
    if (m.role.startsWith('tool_') || (m.role === 'assistant' && m.phase === 'commentary')) {
      const previousTurn = work.find(message => message.turnId)?.turnId;
      if (previousTurn && m.turnId && previousTurn !== m.turnId) flushWork();
      work.push(m);
      continue;
    }
    flushWork();
    html += m.role === 'user' ? `<article class="history-message user"><span class="history-sr-only">用户</span><div class="history-message-body">${escape(m.text)}${images(m)}</div>${renderMessageTime(m.timestamp)}</article>` : `<article class="history-message assistant"><span class="history-sr-only">助手</span><div class="history-message-body history-markdown">${renderMarkdown(m.text)}${images(m)}</div>${renderMessageTime(m.timestamp)}</article>`;
  }
  flushWork();
  return html || '<p class="history-meta">此会话暂无可显示的对话。</p>';
}

function renderMessageTime(timestamp: string | undefined) {
  if (!timestamp || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) return '';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const label = date.toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return `<time class="history-message-time" datetime="${escape(date.toISOString())}" title="${escape(date.toLocaleString('zh-CN'))}">${escape(label)}</time>`;
}
