CREATE TABLE session_contexts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
