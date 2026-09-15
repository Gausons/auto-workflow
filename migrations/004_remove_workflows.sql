CREATE TABLE issue_items (
  tenant_id TEXT NOT NULL,
  user_key TEXT NOT NULL,
  item_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_key, item_id),
  FOREIGN KEY (tenant_id, user_key) REFERENCES user_states(tenant_id, user_key)
) STRICT;

INSERT INTO issue_items (tenant_id, user_key, item_id, position, payload)
SELECT tenant_id, user_key, item_id, position, payload
FROM workflow_items
WHERE kind = 'bugs';

DROP TABLE workflow_items;
CREATE INDEX issue_items_order ON issue_items(tenant_id, user_key, position);

