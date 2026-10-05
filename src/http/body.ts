import type { IncomingMessage } from 'node:http';

type JsonObject = Record<string, unknown>;
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

export async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<JsonObject> {
  // HTTP chunks may split a UTF-8 character. Decode only after collecting bytes.
  const data = await readBytes(req, limit);
  if (!data.length) return {};
  try {
    const parsed: unknown = JSON.parse(data.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象');
    return parsed as JsonObject;
  } catch (error: unknown) { throw Object.assign(asError(error), { statusCode: 400 }); }
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
