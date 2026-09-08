CREATE TABLE organization_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, username),
  UNIQUE (tenant_id, id)
) STRICT;

CREATE TABLE user_sessions (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, user_id) REFERENCES organization_users(tenant_id, id)
) STRICT;
CREATE INDEX user_sessions_user ON user_sessions(tenant_id, user_id);
CREATE INDEX user_sessions_expiry ON user_sessions(expires_at);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX audit_events_tenant ON audit_events(tenant_id, id DESC);
