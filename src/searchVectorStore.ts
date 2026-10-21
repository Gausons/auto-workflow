import type { Connection } from './storage/connection.js';

export interface SearchDocument { id: string; text: string; keywordText?: string }
export interface IndexedDocument { id: string; hash: string }

export function createSearchVectorStore(db: Connection, transaction: <T>(fn: () => T) => T) {
  return {
    indexed(tenant: string, collection: string, profile: string): Map<string, string> {
      return new Map(db.prepare('SELECT DISTINCT document_id, content_hash FROM search_vectors WHERE tenant_id = ? AND collection = ? AND profile = ?')
        .all(tenant, collection, profile).map(row => [String(row.document_id), String(row.content_hash)]));
    },
    replace(tenant: string, collection: string, profile: string, document: IndexedDocument, vectors: number[][]) {
      transaction(() => {
        db.prepare('DELETE FROM search_vectors WHERE tenant_id = ? AND collection = ? AND profile = ? AND document_id = ?').run(tenant, collection, profile, document.id);
        const insert = db.prepare('INSERT INTO search_vectors VALUES (?, ?, ?, ?, ?, ?, ?::vector)');
        vectors.forEach((vector, chunk) => insert.run(tenant, collection, profile, document.id, document.hash, chunk, JSON.stringify(vector)));
      });
    },
    nearest(tenant: string, collection: string, profile: string, documents: IndexedDocument[], vector: number[], threshold: number): string[] {
      if (!documents.length) return [];
      // Materialize authorization/model filters before evaluating distances: other
      // profiles may use different dimensions, and stale/deleted IDs cannot qualify.
      return db.prepare(`WITH candidates AS MATERIALIZED (
        SELECT v.document_id, v.embedding FROM search_vectors v
        JOIN jsonb_to_recordset(?::jsonb) AS allowed(id text, hash text)
          ON v.document_id = allowed.id AND v.content_hash = allowed.hash
        WHERE v.tenant_id = ? AND v.collection = ? AND v.profile = ?
      ) SELECT document_id, MAX(1 - (embedding <=> ?::vector)) AS score FROM candidates
        GROUP BY document_id HAVING MAX(1 - (embedding <=> ?::vector)) >= ?
        ORDER BY score DESC, document_id LIMIT 50`)
        .all(JSON.stringify(documents), tenant, collection, profile, JSON.stringify(vector), JSON.stringify(vector), threshold)
        .map(row => String(row.document_id));
    }
  };
}
