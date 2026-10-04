import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderMessages } from '../web/src/components/historyView.js';

test('history Markdown formats prose while escaping HTML and unsafe links', () => {
  const html = renderMarkdown('**已完成**\n\n- 一项\n- `代码`\n\n<script>alert(1)</script>\n[危险](javascript:alert)\n\n```js\n<b>文本</b>\n```');
  assert.match(html, /<strong>已完成<\/strong>/);
  assert.match(html, /<ul><li>一项<\/li>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|href="javascript:/);
  assert.match(html, /&lt;b&gt;文本&lt;\/b&gt;/);
  assert.match(renderMarkdown('[文档](https://example.com)'), /rel="noopener noreferrer"/);
});

test('history Markdown renders aligned tables with safe rich text and literal pipes', () => {
  const html = renderMarkdown([
    '请核对以下记录：',
    '',
    '| 类型 | 主机记录 | 记录值 |',
    '| :--- | :---: | ---: |',
    '| **A** | `@` | `101.200.204.63` |',
    '| `<script>` | a\\|b | [文档](https://example.com) |',
    '| <img src=x onerror=alert(1)> | `a|b` | [危险](javascript:alert) |',
    '',
    '后续说明。'
  ].join('\n'));
  assert.match(html, /<table><thead><tr><th scope="col" class="history-table-align-left">类型<\/th>/);
  assert.match(html, /<th scope="col" class="history-table-align-center">主机记录<\/th>/);
  assert.match(html, /<th scope="col" class="history-table-align-right">记录值<\/th>/);
  assert.match(html, /<td class="history-table-align-left"><strong>A<\/strong><\/td>/);
  assert.match(html, /<td class="history-table-align-center"><code>@<\/code><\/td>/);
  assert.match(html, /a\|b<\/td>/);
  assert.match(html, /<code>a\|b<\/code>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script|<img|href="javascript:/);
  assert.match(html, /<\/table><\/div><p>后续说明。<\/p>/);
});

test('history Markdown keeps malformed tables and fenced table text literal', () => {
  assert.doesNotMatch(renderMarkdown('| 一列 | 两列 |\n| --- |\n| 内容 |'), /<table>/);
  assert.doesNotMatch(renderMarkdown('```md\n| 一列 |\n| --- |\n| 内容 |\n```'), /<table>/);
  assert.equal(renderMarkdown(undefined), '');
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
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:[\s=>]|$)/);
});

test('only explicit commentary joins collapsed work and final answers remain in the transcript', () => {
  const html = renderMessages([
    { role: 'user', text: '继续', turnId: 'turn-1' },
    { role: 'assistant', text: '开始核对。', phase: 'commentary', turnId: 'turn-1' },
    { role: 'tool_call', text: 'pnpm test', name: 'Bash', turnId: 'turn-1' },
    { role: 'tool_result', text: 'pass', turnId: 'turn-1' },
    { role: 'assistant', text: '核对完成。', phase: 'commentary', turnId: 'turn-1' },
    { role: 'assistant', text: '**已完成**', phase: 'final', turnId: 'turn-1' },
    { role: 'assistant', text: '旧记录没有阶段字段。' }
  ]);
  assert.equal((html.match(/class="history-work"/g) || []).length, 1);
  assert.equal((html.match(/class="history-work-commentary history-markdown"/g) || []).length, 2);
  assert.match(html, /<strong>使用了 1 次工具<\/strong>/);
  assert.match(html, /<\/div><\/details><article class="history-message assistant">.*<strong>已完成<\/strong>/);
  assert.equal((html.match(/<article class="history-message assistant">/g) || []).length, 2);
  assert.doesNotMatch(html, /assistant:|user:|用时|<details[^>]*\bopen(?:[\s=>]|$)/);
});

test('work groups respect distinct known turns and escape progress text', () => {
  const html = renderMessages([
    { role: 'assistant', text: '<script>unsafe</script>', phase: 'commentary', turnId: 'turn-1' },
    { role: 'assistant', text: '新的工作过程', phase: 'commentary', turnId: 'turn-2' }
  ]);
  assert.equal((html.match(/class="history-work"/g) || []).length, 2);
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script/);
});

test('messages show source timestamps without inventing missing or ambiguous times', () => {
  const html = renderMessages([
    { role: 'user', text: '继续', timestamp: '2026-10-02T21:52:00+08:00' },
    { role: 'assistant', text: '已完成', timestamp: '2026-10-02T13:53:21.000Z' },
    { role: 'assistant', text: '没有时间' },
    { role: 'assistant', text: '无效时间', timestamp: 'invalid' },
    { role: 'assistant', text: '只有日期', timestamp: '2026-10-02' },
    { role: 'assistant', text: '缺少时区', timestamp: '2026-10-02T21:52:00' }
  ]);
  assert.equal((html.match(/<time /g) || []).length, 2);
  assert.match(html, /<div class="history-message-body">继续<\/div><time class="history-message-time" datetime="2026-10-02T13:52:00.000Z"/);
  assert.match(html, /datetime="2026-10-02T13:53:21.000Z"/);
  assert.doesNotMatch(html, /Invalid Date|时间未知|undefined/);
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
