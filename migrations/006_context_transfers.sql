CREATE TABLE context_transfers (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  target_device_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('available', 'failed')),
  failure TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, execution_id),
  CHECK(source_device_id <> target_device_id)
);
CREATE INDEX context_transfers_by_target ON context_transfers(tenant_id, target_device_id, status);
