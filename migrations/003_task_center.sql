CREATE TABLE task_centers (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  payload TEXT NOT NULL DEFAULT '{"tasks":[],"devices":[],"sessions":[],"handoffs":[]}'
);
