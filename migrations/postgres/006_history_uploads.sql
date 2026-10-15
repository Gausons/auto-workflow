CREATE TABLE IF NOT EXISTS remote_history_uploads (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  size INTEGER NOT NULL,
  complete BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (tenant_id, session_id)
);
