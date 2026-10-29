CREATE TABLE IF NOT EXISTS device_deployment_tokens (
  token_hash VARCHAR(64) PRIMARY KEY,
  parent_session_hash VARCHAR(64) NOT NULL UNIQUE REFERENCES user_sessions(token_hash) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_connector_sessions (
  token_hash VARCHAR(64) PRIMARY KEY REFERENCES user_sessions(token_hash) ON DELETE CASCADE
);
