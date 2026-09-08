CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE tenant_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  config TEXT NOT NULL DEFAULT '{}',
  assignment_people TEXT NOT NULL DEFAULT '[]'
) STRICT;

CREATE TABLE user_states (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_key TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_key)
) STRICT;

CREATE TABLE workflow_items (
  tenant_id TEXT NOT NULL,
  user_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bugs', 'runs', 'executionRecords')),
  item_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_key, kind, item_id),
  FOREIGN KEY (tenant_id, user_key) REFERENCES user_states(tenant_id, user_key)
) STRICT;
CREATE INDEX workflow_items_order ON workflow_items(tenant_id, user_key, kind, position);

CREATE TABLE imports (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  source TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, source)
) STRICT;
