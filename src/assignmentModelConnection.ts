import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { httpError } from './rbac.js';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

export function modelBaseUrl(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : '';
  const url = text.length <= 2048 ? URL.parse(text) : null;
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(url.href)) {
    throw httpError(400, 'OpenAI Base URL 必须是有效的 HTTP 或 HTTPS 地址，且不能包含凭据、查询参数或片段');
  }
  return url.href.replace(/\/+$/, '');
}

export function modelApiKey(value: unknown) {
  if (typeof value !== 'string' || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value.trim())) {
    throw httpError(400, 'OpenAI API Key 格式无效');
  }
  return value.trim();
}

export function assignmentModelId(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 256 || /[\s\p{Cc}]/u.test(value.trim())) {
    throw httpError(400, '请输入有效的 AI 分配模型 ID（最多 256 字符，不能包含空白）');
  }
  return value.trim();
}

export interface AssignmentModelPayload { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> }

export function requestAssignmentModel(baseUrl: string, apiKey: string, body: unknown, signal: AbortSignal) {
  const url = new URL(`${baseUrl}/responses`);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const data = JSON.stringify(body);
  return new Promise<AssignmentModelPayload>((resolve, reject) => {
    const request = send(url, {
      method: 'POST', signal, agent: false,
      headers: {
        Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Accept-Encoding': 'identity',
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data)
      }
    }, response => {
      response.on('error', reject);
      const status = response.statusCode || 502;
      if (status < 200 || status >= 300) {
        response.destroy();
        const message = status === 401 || status === 403 ? '模型服务拒绝认证，请检查 API Key 和访问权限'
          : status === 429 ? '模型服务请求受限，请检查配额或稍后重试'
          : '模型服务请求失败，请检查 Base URL、模型 ID 和 Responses API 支持情况';
        reject(httpError(502, `${message}（HTTP ${status}）`));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 1_000_000) response.destroy(httpError(502, '模型服务响应过大'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
          resolve(payload as AssignmentModelPayload);
        } catch { reject(httpError(502, '模型服务响应格式无效')); }
      });
    });
    request.on('error', reject);
    request.end(data);
  });
}

export function assignmentModelError(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return signal.reason?.name === 'TimeoutError' ? httpError(504, '模型服务连接超时') : httpError(503, '模型服务请求已取消');
  if (error instanceof Error && 'statusCode' in error) return error;
  return httpError(502, '无法连接模型服务，请检查 Base URL 和服务端网络');
}

export function assignmentResponseText(payload: AssignmentModelPayload) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  const chunks: string[] = [];
  if (Array.isArray(payload.output)) for (const item of payload.output) {
    if (Array.isArray(item?.content)) for (const part of item.content) if (typeof part?.text === 'string') chunks.push(part.text);
  }
  const text = chunks.join('\n').trim();
  if (!text) throw httpError(502, '模型服务未返回有效文本');
  return text;
}
