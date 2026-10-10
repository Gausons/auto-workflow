CREATE TABLE IF NOT EXISTS task_center_changes (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version BIGINT NOT NULL CHECK (version > 0),
  changes JSONB NOT NULL,
  PRIMARY KEY (tenant_id, version)
);
