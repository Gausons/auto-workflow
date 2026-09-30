import { createElement, useMemo, type ReactNode } from 'react';

// Rebuild supported formatting as React elements; never copy source attributes or HTML.
const allowedTags = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'hr']);
export function IssueContent({ text }: { text: string }) {
  const content = useMemo(() => {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    function render(node: Node, key: number): ReactNode {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (!(node instanceof Element)) return null;
      const tag = node.tagName.toLowerCase();
      if (!allowedTags.has(tag)) return node.outerHTML;
      return createElement(tag, { key }, ...Array.from(node.childNodes, render));
    }
    // Plain text (including code-like angle brackets) must remain unchanged.
    return /<\/?(?:p|br|strong|b|em|i|u|ul|ol|li|blockquote|pre|code|h[1-4]|hr)(?:\s|>|\/)/i.test(text)
      ? Array.from(doc.body.childNodes, render) : text;
  }, [text]);
  return <div>{content}</div>;
}

export function formatIssueTime(value: string | number | undefined) {
  if (value === undefined || value === '') return '未知';
  const date = new Date(typeof value === 'number' || /^\d+$/.test(value) ? Number(value) : value);
  if (Number.isNaN(date.getTime())) return '未知';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
