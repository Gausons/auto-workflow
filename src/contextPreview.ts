import { contextContentParts, decodeContextContent } from '../shared/contextContent.js';
import type { ContextPreviewMessage, ContextPreviewResponse } from '../shared/contextPreviewTypes.js';
import type { ContextEntry } from './contextCompiler.js';

const maxTextLength = 12000;
const maxImageBytes = 2 * 1024 * 1024;
const maxPreviewImageBytes = 8 * 1024 * 1024;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safeText = (value: string) => value
  .replace(/data:image\/[^;,\s"'<>]+;base64,[A-Za-z0-9+/=\r\n]+/g, '[图片编码已隐藏，请查看图片预览]')
  .replace(/("(?:data|image_url)"\s*:\s*")[A-Za-z0-9+/=]{200,}("?)/g, '$1[大段编码已隐藏]$2');

function imagePreview(value: Record<string, unknown>, remaining: number): { image: NonNullable<ContextPreviewMessage['images']>[number]; bytes: number } {
  const source = object(value.source);
  const imageUrl = typeof value.image_url === 'string' ? value.image_url : object(value.image_url).url;
  const match = typeof imageUrl === 'string' ? /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(imageUrl) : null;
  const mimeType = match?.[1] || (source.type === 'base64' ? source.media_type : value.mimeType);
  const data = match?.[2] || (source.type === 'base64' ? source.data : value.data);
  const unavailable = (reason: string) => ({ image: { alt: `图片无法预览：${reason}` }, bytes: 0 });
  if (value.type === 'image_reference') return unavailable(typeof value.reason === 'string' ? safeText(value.reason).slice(0, 160) : '此处仅保存图片引用');
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(String(mimeType)) || typeof data !== 'string') return unavailable('未提供受支持的内嵌原图');
  if (data.length > Math.ceil(maxImageBytes / 3) * 4 + 100) return unavailable('图片超过 2 MB 预览上限，原文不受影响');
  const normalized = data.replace(/[\r\n]/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) return unavailable('图片编码无效');
  const bytes = Buffer.from(normalized, 'base64');
  if (!bytes.length || bytes.toString('base64') !== normalized) return unavailable('图片编码无效');
  const matchesType = mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mimeType === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mimeType === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
        : bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!matchesType) return unavailable('图片内容与类型不匹配');
  if (bytes.length > maxImageBytes) return unavailable('图片超过 2 MB 预览上限，原文不受影响');
  if (bytes.length > remaining) return unavailable('图片总量超过 8 MB 预览上限，原文不受影响');
  return { image: { dataUrl: `data:${mimeType};base64,${normalized}`, alt: typeof value.alt === 'string' ? safeText(value.alt).slice(0, 160) : '历史上下文图片' }, bytes: bytes.length };
}

/** A bounded display projection. It never mutates or replaces the transfer snapshot. */
export function normalizedContextPreview(entries: ContextEntry[], offset = 0, limit = 100): ContextPreviewResponse {
  const stats: ContextPreviewResponse['stats'] = { users: 0, assistants: 0, tools: 0, references: 0, images: 0, unavailableImages: 0, truncatedMessages: 0, unsupportedBlocks: 0 };
  const messages: ContextPreviewMessage[] = [];
  const recent: ContextPreviewResponse['excerpts'] = [];
  let firstUser: ContextPreviewResponse['excerpts'][number] | undefined;
  let previewImageBytes = 0;
  entries.forEach((entry, index) => {
    if (entry.role === 'user') stats.users += 1;
    else if (entry.role === 'assistant') stats.assistants += 1;
    else if (entry.role === 'tool_call' || entry.role === 'tool_result') stats.tools += 1;
    else stats.references += 1;
    const content = contextContentParts(entry);
    const text: string[] = [];
    const images: NonNullable<ContextPreviewMessage['images']> = [];
    for (const part of content) {
      if (part.type === 'text') {
        const cleaned = safeText(part.text);
        if (cleaned !== part.text) stats.unsupportedBlocks += 1;
        text.push(cleaned);
      } else if (part.type === 'attachment') {
        text.push(`附件：${safeText(String(part.value.name || '未命名附件'))}${part.value.path ? `\n${safeText(String(part.value.path))}` : ''}\n仅保留引用，文件未复制。`);
      } else {
        stats.images += 1;
        const result = imagePreview(part.value, maxPreviewImageBytes - previewImageBytes);
        previewImageBytes += result.bytes;
        if (!result.image.dataUrl) stats.unavailableImages += 1;
        images.push(result.image);
      }
    }
    const fullText = text.join('\n\n');
    const truncated = fullText.length > maxTextLength;
    if (truncated) stats.truncatedMessages += 1;
    const body = truncated ? `${fullText.slice(0, maxTextLength)}\n[预览已截取，完整原文保留在交接记录中]` : fullText;
    const decoded = decodeContextContent(entry);
    const protocol = Array.isArray(decoded) ? decoded.map(object).find(value => typeof value.name === 'string' || value.call_id || value.tool_use_id) || {} : object(decoded);
    const metadata = entry as ContextEntry & { name?: string; callId?: string; phase?: 'commentary' | 'final' };
    const name = metadata.name || (typeof protocol.name === 'string' ? protocol.name : undefined);
    const callId = metadata.callId || [protocol.call_id, protocol.tool_use_id, protocol.id].find((value): value is string => typeof value === 'string');
    if (index >= offset && index < offset + limit) messages.push({
      record: index + 1, source: entry.source, ...(entry.line ? { line: entry.line } : {}),
      role: ['user', 'assistant', 'tool_call', 'tool_result'].includes(entry.role) ? entry.role : 'tool_result',
      text: body, ...(images.length ? { images } : {}), ...(truncated ? { truncated: true } : {}),
      ...(name ? { name: safeText(name).slice(0, 200) } : {}), ...(callId ? { callId: safeText(callId).slice(0, 200) } : {}),
      ...(metadata.phase ? { phase: metadata.phase } : {}), ...(entry.turnId ? { turnId: entry.turnId } : {}), ...(entry.timestamp ? { timestamp: entry.timestamp } : {})
    });
    if (['user', 'assistant'].includes(entry.role) && fullText.trim()) {
      const excerpt = { record: index + 1, role: entry.role, source: entry.source, ...(entry.line ? { line: entry.line } : {}), text: fullText.length > 280 ? `${fullText.slice(0, 280)}…` : fullText };
      if (entry.role === 'user' && !firstUser) firstUser = excerpt;
      recent.push(excerpt);
      if (recent.length > 3) recent.shift();
    }
  });
  const first = firstUser;
  const excerpts = first && !recent.some(item => item.record === first.record) ? [first, ...recent] : recent;
  return { messages, total: entries.length, offset, nextOffset: offset + messages.length < entries.length ? offset + messages.length : null, stats, excerpts };
}
