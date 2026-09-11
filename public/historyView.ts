// Restricted Markdown renderer; attachments are validated separately from message text.
type HistoryImage = { dataUrl?: string; alt?: string };
type HistoryMessage = { role: string; text?: string; name?: string; callId?: string; images?: HistoryImage[] };
const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escape = (text: unknown) => String(text ?? '').replace(/[&<>"']/g, (c) => entities[c] || c);
function inline(text: any) {
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let output = '', offset = 0;
  for (const match of text.matchAll(pattern)) {
    output += escape(text.slice(offset, match.index));
    output += match[1] ? `<code>${escape(match[1])}</code>` : match[2] ? `<strong>${escape(match[2])}</strong>` : `<a href="${escape(match[4])}" target="_blank" rel="noopener noreferrer">${escape(match[3])}</a>`;
    offset = match.index + match[0].length;
  }
  return output + escape(text.slice(offset));
}
export function renderMarkdown(text: any) {
  const lines = String(text).split('\n');
  let html = '', paragraph: any = [], list: any = null, fence = null, code = [];
  const flush: any = () => { if (paragraph.length) { html += `<p>${paragraph.map(inline).join('<br>')}</p>`; paragraph = []; } if (list) { html += `</${list}>`; list = null; } };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (fence !== null) { html += `<div class="history-code"><span>${escape(fence || '代码')}</span><pre><code>${escape(code.join('\n'))}</code></pre></div>`; fence = null; code = []; }
      else { flush(); fence = line.trim().slice(3); }
      continue;
    }
    if (fence !== null) { code.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
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
export function renderMessages(messages: HistoryMessage[]) {
  let html = '', tools: any = [];
  function flushTools() {
    if (!tools.length) return;
    const calls: any = tools.filter((m: any) => m.role === 'tool_call');
    html += `<details class="history-work"><summary><span class="history-work-icon">⌘</span><span><strong>${calls.length ? `使用了 ${calls.length} 次工具` : '工具输出'}</strong><small>查看工作过程</small></span><span class="history-chevron">›</span></summary><div class="history-work-body">`;
    for (const m of tools) html += `<details class="history-tool"><summary>${escape(m.role === 'tool_call' ? m.name || '工具调用' : '工具结果')}<span>${escape(m.callId || '')}</span></summary><pre>${escape(m.text)}</pre></details>`;
    html += '</div></details>'; tools = [];
  }
  for (const m of messages) {
    if (m.role.startsWith('tool_')) { tools.push(m); continue; }
    flushTools();
    html += m.role === 'user' ? `<article class="history-message user"><span class="history-sr-only">用户</span><div>${escape(m.text)}${renderImages(m.images)}</div></article>` : `<article class="history-message assistant"><span class="history-sr-only">助手</span><div class="history-markdown">${renderMarkdown(m.text)}${renderImages(m.images)}</div></article>`;
  }
  flushTools();
  return html || '<p class="history-meta">此会话暂无可显示的对话。</p>';
}
