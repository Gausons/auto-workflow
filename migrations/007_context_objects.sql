CREATE TABLE context_transfer_objects (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length > 0 AND byte_length <= 12582912),
  data BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, execution_id, digest)
);
CREATE TABLE context_transfer_manifests (
  tenant_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version = 3),
  manifest_digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, execution_id, schema_version),
  FOREIGN KEY (tenant_id, execution_id) REFERENCES context_transfers(tenant_id, execution_id) ON DELETE CASCADE
);
