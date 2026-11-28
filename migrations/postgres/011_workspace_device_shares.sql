CREATE TABLE IF NOT EXISTS workspace_device_shares (
  tenant_id VARCHAR(63) NOT NULL,
  account_id VARCHAR(256) NOT NULL,
  device_id VARCHAR(80) NOT NULL,
  device_metadata TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (tenant_id, device_id),
  FOREIGN KEY (account_id, tenant_id) REFERENCES workspace_memberships(account_id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS workspace_device_shares_account_idx
  ON workspace_device_shares(account_id, device_id);

ALTER TABLE device_connector_sessions ADD COLUMN IF NOT EXISTS device_id VARCHAR(80);
