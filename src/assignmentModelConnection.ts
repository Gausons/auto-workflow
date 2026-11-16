import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { httpError } from './rbac.js';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

const privateAddress = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]
] as const) privateAddress.addSubnet(address, prefix);
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  privateAddress.addSubnet(address, prefix, 'ipv6');
}
const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');

function publicAddress(address: string, family: number) {
  return family === 4 ? !privateAddress.check(address) : globalIpv6.check(address, 'ipv6') && !privateAddress.check(address, 'ipv6');
}

const blocked = () => httpError(400, '内网模型地址需由部署管理员通过 OPENAI_BASE_URL 配置');

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

export function requestAssignmentModel(baseUrl: string, apiKey: string, body: unknown, signal: AbortSignal, trustedBaseUrl: string) {
  const url = new URL(`${baseUrl}/responses`);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const trusted = baseUrl === trustedBaseUrl;
  if (!trusted && family && !publicAddress(hostname, family)) throw blocked();
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const data = JSON.stringify(body);
  return new Promise<AssignmentModelPayload>((resolve, reject) => {
    const request = send(url, {
      method: 'POST', signal, agent: false,
      headers: {
        Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Accept-Encoding': 'identity',
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data)
      },
      // Validate the exact address used by the socket, retaining the URL hostname for TLS.
      lookup: trusted ? undefined : (host, options, callback) => {
        lookup(host, { ...options, all: true }, (error, addresses) => {
          if (error) return callback(error, '', 0);
          const allowed = addresses.filter(item => publicAddress(item.address, item.family));
          if (!allowed.length) return callback(blocked(), '', 0);
          if (options.all) callback(null, allowed);
          else callback(null, allowed[0].address, allowed[0].family);
        });
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
