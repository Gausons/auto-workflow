CREATE TABLE remote_session_history (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (tenant_id, session_id)
);

-- Early structured-preview builds stored bodies in the task-center document.
-- Move them once during the upgrade, before ordinary heartbeats resume.
INSERT INTO remote_session_history (tenant_id, session_id, payload)
SELECT center.tenant_id, session->>'id', session->'remoteHistory'
FROM task_centers center,
  LATERAL jsonb_array_elements(COALESCE(center.payload::jsonb->'sessions', '[]'::jsonb)) session
WHERE jsonb_typeof(session->'remoteHistory') = 'object';

UPDATE task_centers center
SET payload = jsonb_set(center.payload::jsonb, '{sessions}', (
  SELECT jsonb_agg(CASE WHEN jsonb_typeof(session->'remoteHistory') = 'object' THEN
    (session - 'remoteHistory') || jsonb_build_object(
      'recordMode', 'synced',
      'syncedRange', (session->'remoteHistory') - 'messages',
      'messageCount', session->'remoteHistory'->'total',
      'partial', (session->'remoteHistory'->>'sourcePartial')::boolean
        OR (session->'remoteHistory'->>'truncated')::boolean
        OR (session->'remoteHistory'->>'offset')::bigint > 0
        OR jsonb_array_length(session->'remoteHistory'->'messages') < (session->'remoteHistory'->>'total')::bigint
    ) ELSE session END ORDER BY position)
  FROM jsonb_array_elements(center.payload::jsonb->'sessions') WITH ORDINALITY AS entries(session, position)
))::text
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(COALESCE(center.payload::jsonb->'sessions', '[]'::jsonb)) session
  WHERE jsonb_typeof(session->'remoteHistory') = 'object'
);
