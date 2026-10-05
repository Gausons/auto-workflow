CREATE TABLE remote_session_images (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  record_number INTEGER NOT NULL,
  image_index INTEGER NOT NULL,
  metadata JSONB NOT NULL,
  data_url TEXT,
  byte_length INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, session_id, image_id),
  UNIQUE (tenant_id, session_id, record_number, image_index)
);
