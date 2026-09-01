-- Attention Items are durable Timeline classifications; reviews are scoped to one Member and idempotent.
CREATE TABLE IF NOT EXISTS tracegarden_attention_items (
  entry_id text PRIMARY KEY REFERENCES tracegarden_timeline_entries (id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES tracegarden_workspaces (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracegarden_attention_items_workspace_idx
  ON tracegarden_attention_items (workspace_id, entry_id);

CREATE TABLE IF NOT EXISTS tracegarden_attention_reviews (
  entry_id text NOT NULL REFERENCES tracegarden_attention_items (entry_id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES tracegarden_members (id) ON DELETE CASCADE,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, member_id)
);
CREATE INDEX IF NOT EXISTS tracegarden_attention_reviews_member_idx
  ON tracegarden_attention_reviews (member_id, entry_id);

INSERT INTO tracegarden_attention_items (entry_id, workspace_id)
SELECT t.id, t.workspace_id
  FROM tracegarden_timeline_entries t
  JOIN tracegarden_observations o ON o.id = t.observation_id
 WHERE o.facts->>'ready' = 'false'
    OR o.facts->>'phase' = 'Failed'
    OR (o.facts->>'reason' IS NOT NULL AND o.facts->>'reason' NOT IN ('Completed', 'Succeeded'))
ON CONFLICT (entry_id) DO NOTHING;
