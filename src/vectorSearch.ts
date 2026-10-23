import { createHash } from 'node:crypto';
import type { SearchResult } from '../shared/searchTypes.js';
import type { Environment } from './issueSources/types.js';
import type { createSearchVectorStore, SearchDocument } from './searchVectorStore.js';
import { httpError } from './rbac.js';

type Store = ReturnType<typeof createSearchVectorStore>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const warning = '向量搜索暂不可用，当前仅显示关键词匹配结果。';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function vectorSearchEnabled(environment: Environment): boolean {
  return !['false', '0', 'no', 'off'].includes((environment.VECTOR_SEARCH_ENABLED || '').trim().toLowerCase());
}

export function searchQuery(params: URLSearchParams): string {
  const q = (params.get('q') || '').trim().toLowerCase();
  if (q.length > 200) throw httpError(400, '搜索词不能超过 200 字符');
  return q;
}

export function createVectorSearch({ store, tenantId, environment, fetch: request = globalThis.fetch }: {
  store: Store; tenantId: string; environment: Environment; fetch?: typeof globalThis.fetch;
}) {
  const enabled = vectorSearchEnabled(environment);
  const base = (environment.VECTOR_SEARCH_BASE_URL || environment.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = environment.VECTOR_SEARCH_MODEL || 'text-embedding-3-small';
  const dimensions = Number(environment.VECTOR_SEARCH_DIMENSIONS || 1536);
  const threshold = Number(environment.VECTOR_SEARCH_MIN_SCORE || 0.4);
  const apiKey = environment.VECTOR_SEARCH_API_KEY || environment.OPENAI_API_KEY;
  if (enabled && (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096 || !Number.isFinite(threshold) || threshold < 0 || threshold > 1)) throw new Error('向量搜索维度或相似度阈值配置无效');
  if (enabled) {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('向量搜索服务地址无效');
  }
  const profile = hash(JSON.stringify(['chunks-v1', base, model, dimensions]));
  const abort = new AbortController();
  const queries = new Map<string, number[]>();
  let queue: Promise<unknown> = Promise.resolve(), queued = 0;
  async function embed(input: string[], signal: AbortSignal): Promise<number[][]> {
    const response = await request(`${base}/embeddings`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, dimensions, input, encoding_format: 'float' })
    });
    if (!response.ok) throw new Error('embedding request failed');
    const data: unknown = await response.json();
    const rows = record(data).data;
    if (!Array.isArray(rows) || rows.length !== input.length) throw new Error('invalid embeddings');
    const vectors: number[][] = new Array(input.length);
    for (const value of rows) {
      const { index, embedding } = record(value);
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= input.length || vectors[index] || !Array.isArray(embedding) || embedding.length !== dimensions ||
        !embedding.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 3.4e38) || !embedding.some(v => v !== 0)) throw new Error('invalid embedding vector');
      vectors[index] = embedding;
    }
    signal.throwIfAborted();
    return vectors;
  }
  return {
    async search(collection: string, query: string, documents: SearchDocument[]): Promise<SearchResult> {
      const q = query.trim().toLowerCase();
      if (q.length > 200) throw httpError(400, '搜索词不能超过 200 字符');
      const lexical = documents.filter(doc => !q || (doc.keywordText ?? doc.text).toLowerCase().includes(q)).map(doc => doc.id);
      if (!enabled || !q || !documents.length) return { ids: lexical, mode: 'keyword' };
      if (!apiKey && !environment.VECTOR_SEARCH_BASE_URL && !environment.OPENAI_BASE_URL) return { ids: lexical, mode: 'keyword', warning };
      if (abort.signal.aborted || queued >= 8) return { ids: lexical, mode: 'keyword', warning };
      queued++;
      const deadline = Date.now() + 30_000;
      const operation = queue.then(async (): Promise<SearchResult> => {
        const controller = new AbortController(), signal = controller.signal;
        const cancel = () => controller.abort();
        abort.signal.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(cancel, Math.max(1, deadline - Date.now()));
        if (abort.signal.aborted || Date.now() >= deadline) cancel();
        try {
          signal.throwIfAborted();
          const prepared = documents.map(doc => {
            const text = doc.text.trim().slice(0, 12000) || doc.id;
            return { id: doc.id, hash: hash(text), chunks: text.match(/[\s\S]{1,1500}/gu) || [text] };
          });
          const indexed = store.indexed(tenantId, collection, profile);
          const missing = prepared.filter(doc => indexed.get(doc.id) !== doc.hash);
          // Bound first-search work; subsequent searches resume from committed documents.
          const pending = missing.slice(0, 100);
          for (let start = 0; start < pending.length; start += 4) {
            const batch = pending.slice(start, start + 4);
            const vectors = await embed(batch.flatMap(doc => doc.chunks), signal);
            let offset = 0;
            for (const doc of batch) {
              store.replace(tenantId, collection, profile, doc, vectors.slice(offset, offset + doc.chunks.length));
              offset += doc.chunks.length;
            }
          }
          let vector = queries.get(q);
          if (!vector) {
            [vector] = await embed([q], signal);
            if (queries.size >= 64) queries.delete(queries.keys().next().value!);
            queries.set(q, vector);
          }
          signal.throwIfAborted();
          const semantic = store.nearest(tenantId, collection, profile, prepared.map(({ id, hash }) => ({ id, hash })), vector, threshold);
          return { ids: [...new Set([...lexical, ...semantic])], mode: 'hybrid',
            ...(missing.length > pending.length ? { warning: '向量索引尚未完成，当前显示关键词和已索引的语义结果；再次搜索会继续建立索引。' } : {}) };
        } catch {
          // Never expose upstream response bodies (which may contain credentials).
          return { ids: lexical, mode: 'keyword', warning };
        } finally {
          clearTimeout(timer); abort.signal.removeEventListener('abort', cancel);
        }
      });
      queue = operation.finally(() => { queued--; });
      return operation;
    },
    async close() { abort.abort(); await queue; queries.clear(); }
  };
}
export type VectorSearch = ReturnType<typeof createVectorSearch>;
