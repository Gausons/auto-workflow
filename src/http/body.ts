import type { IncomingMessage } from 'node:http';

type JsonObject = Record<string, unknown>;
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

export function readJson(req: IncomingMessage, limit = 1_000_000): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let data = '', size = 0; req.on('data', (chunk: Buffer | string) => { size += Buffer.byteLength(chunk); if (size > limit) { reject(Object.assign(new Error('请求体过大'), { statusCode: 413 })); return; } data += chunk; });
    req.on('end', () => { if (!data) return resolve({}); try { const parsed: unknown = JSON.parse(data); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象'); resolve(parsed as JsonObject); } catch (error: unknown) { reject(Object.assign(asError(error), { statusCode: 400 })); } }); req.on('error', reject);
  });
}
export async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of req) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += bytes.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { statusCode: 413 });
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}
