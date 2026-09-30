CREATE TABLE IF NOT EXISTS tenants (
  id VARCHAR(63) PRIMARY KEY,
  name LONGTEXT NOT NULL,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  created_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id VARCHAR(63) PRIMARY KEY,
  config LONGTEXT NOT NULL DEFAULT ('{}'),
  assignment_people LONGTEXT NOT NULL DEFAULT ('[]'),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS user_states (
  tenant_id VARCHAR(63) NOT NULL,
  user_key VARCHAR(256) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (tenant_id, user_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS imports (
  tenant_id VARCHAR(63) NOT NULL,
  source VARCHAR(640) NOT NULL,
  imported_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (tenant_id, source),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS organization_users (
  id VARCHAR(256) PRIMARY KEY,
  tenant_id VARCHAR(63) NOT NULL,
  username VARCHAR(256) NOT NULL,
  display_name LONGTEXT NOT NULL,
  password_hash LONGTEXT NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE (tenant_id, username),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(63) NOT NULL,
  user_id VARCHAR(256) NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (tenant_id, user_id) REFERENCES organization_users(tenant_id, id),
  INDEX user_sessions_user (tenant_id, user_id),
  INDEX user_sessions_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id VARCHAR(63) NOT NULL,
  actor_id LONGTEXT,
  actor_name LONGTEXT NOT NULL,
  action LONGTEXT NOT NULL,
  target LONGTEXT NOT NULL,
  detail LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  INDEX audit_events_tenant (tenant_id, id DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS task_centers (
  tenant_id VARCHAR(63) PRIMARY KEY,
  payload LONGTEXT NOT NULL DEFAULT ('{"tasks":[],"devices":[],"sessions":[],"handoffs":[]}'),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS session_contexts (
  tenant_id VARCHAR(63) NOT NULL,
  id VARCHAR(256) NOT NULL,
  payload LONGTEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS context_transfers (
  tenant_id VARCHAR(63) NOT NULL,
  execution_id VARCHAR(256) NOT NULL,
  source_device_id VARCHAR(256) NOT NULL,
  target_device_id VARCHAR(256) NOT NULL,
  snapshot_id VARCHAR(256) NOT NULL,
  snapshot_digest VARCHAR(64) NOT NULL,
  manifest_digest VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK(status IN ('available', 'failed')),
  failure LONGTEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (tenant_id, execution_id),
  CHECK(source_device_id <> target_device_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  INDEX context_transfers_by_target (tenant_id, target_device_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS context_transfer_objects (
  tenant_id VARCHAR(63) NOT NULL,
  execution_id VARCHAR(256) NOT NULL,
  digest VARCHAR(64) NOT NULL,
  mime_type LONGTEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length > 0 AND byte_length <= 12582912),
  data LONGBLOB NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (tenant_id, execution_id, digest),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE TABLE IF NOT EXISTS context_transfer_manifests (
  tenant_id VARCHAR(63) NOT NULL,
  execution_id VARCHAR(256) NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version = 3),
  manifest_digest VARCHAR(64) NOT NULL,
  payload LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (tenant_id, execution_id, schema_version),
  FOREIGN KEY (tenant_id, execution_id) REFERENCES context_transfers(tenant_id, execution_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS auth_identities (
  provider VARCHAR(32) NOT NULL,
  subject VARCHAR(256) NOT NULL,
  tenant_id VARCHAR(63) NOT NULL,
  user_id VARCHAR(256) NOT NULL,
  email LONGTEXT,
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE (tenant_id, user_id, provider),
  FOREIGN KEY (tenant_id, user_id) REFERENCES organization_users(tenant_id, id) ON DELETE CASCADE,
  INDEX auth_identities_user (tenant_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS issue_items (
  tenant_id VARCHAR(63) NOT NULL,
  user_key VARCHAR(256) NOT NULL,
  item_id VARCHAR(256) NOT NULL,
  position INTEGER NOT NULL,
  payload LONGTEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_key, item_id),
  FOREIGN KEY (tenant_id, user_key) REFERENCES user_states(tenant_id, user_key),
  INDEX issue_items_order (tenant_id, user_key, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS write_lock (id INT PRIMARY KEY) ENGINE=InnoDB;
INSERT IGNORE INTO write_lock VALUES (1);
CREATE TABLE IF NOT EXISTS sqlite_imports (digest VARCHAR(64) PRIMARY KEY, imported_at VARCHAR(32) NOT NULL) ENGINE=InnoDB;
