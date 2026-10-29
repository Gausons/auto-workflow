CREATE TABLE IF NOT EXISTS team_workspaces (
  tenant_id VARCHAR(63) PRIMARY KEY REFERENCES tenants(id),
  creator_id VARCHAR(256) NOT NULL REFERENCES organization_users(id),
  request_id VARCHAR(64) NOT NULL,
  UNIQUE (creator_id, request_id)
);
CREATE TABLE IF NOT EXISTS workspace_memberships (
  account_id VARCHAR(256) NOT NULL REFERENCES organization_users(id),
  tenant_id VARCHAR(63) NOT NULL REFERENCES team_workspaces(tenant_id),
  member_id VARCHAR(256) NOT NULL UNIQUE,
  PRIMARY KEY (account_id, tenant_id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES organization_users(tenant_id, id)
);
CREATE TABLE IF NOT EXISTS workspace_invitations (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(63) NOT NULL REFERENCES team_workspaces(tenant_id),
  account_id VARCHAR(256) NOT NULL REFERENCES organization_users(id),
  role VARCHAR(16) NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'accepted', 'cancelled')),
  created_at VARCHAR(32) NOT NULL,
  expires_at BIGINT NOT NULL,
  UNIQUE (tenant_id, account_id)
);

CREATE INDEX IF NOT EXISTS workspace_memberships_tenant_idx ON workspace_memberships(tenant_id);
CREATE INDEX IF NOT EXISTS workspace_invitations_account_idx ON workspace_invitations(account_id, status, expires_at);
