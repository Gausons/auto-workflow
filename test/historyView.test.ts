// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderMessages } from '../public/historyView.js';

test('history Markdown formats prose while escaping HTML and unsafe links', () => {
  const html = renderMarkdown('**已完成**\n\n- 一项\n- `代码`\n\n<script>alert(1)</script>\n[危险](javascript:alert)\n\n```js\n<b>文本</b>\n```');
  assert.match(html, /<strong>已完成<\/strong>/);
  assert.match(html, /<ul><li>一项<\/li>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|href="javascript:/);
  assert.match(html, /&lt;b&gt;文本&lt;\/b&gt;/);
  assert.match(renderMarkdown('[文档](https://example.com)'), /rel="noopener noreferrer"/);
});

test('consecutive tools collapse together and user content remains literal', () => {
  const html = renderMessages([
    { role: 'user', text: '**literal** <img src=x>' },
    { role: 'tool_call', text: 'npm test', name: 'Bash' },
    { role: 'tool_result', text: 'pass' },
    { role: 'tool_call', text: 'git diff', name: 'Bash' },
    { role: 'assistant', text: '**完成**' }
  ]);
  assert.equal((html.match(/class="history-work"/g) || []).length, 1);
  assert.match(html, /使用了 2 次工具/);
  assert.match(html, /\*\*literal\*\* &lt;img/);
  assert.match(html, /<strong>完成<\/strong>/);
});

test('renders embedded raster attachments but not remote or active image sources', () => {
  const html = renderMessages([{ role: 'user', text: '图片', images: [
    { dataUrl: 'data:image/png;base64,aGVsbG8=', alt: '预览' },
    { dataUrl: 'https://example.com/track.png' },
    { dataUrl: 'data:image/svg+xml;base64,aGVsbG8=' }
  ] }]);
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.match(html, /loading="lazy"/);
  assert.doesNotMatch(html, /src="https:|src="data:image\/svg/);
});
