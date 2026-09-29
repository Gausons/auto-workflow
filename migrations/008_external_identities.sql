CREATE TABLE auth_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE (tenant_id, user_id, provider),
  FOREIGN KEY (tenant_id, user_id) REFERENCES organization_users(tenant_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX auth_identities_user ON auth_identities(tenant_id, user_id);
