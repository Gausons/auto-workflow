CREATE TABLE IF NOT EXISTS search_vectors (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  profile TEXT NOT NULL,
  document_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  chunk INTEGER NOT NULL,
  embedding vector NOT NULL,
  PRIMARY KEY (tenant_id, collection, profile, document_id, chunk)
);
