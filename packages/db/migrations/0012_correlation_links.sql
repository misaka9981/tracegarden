-- Correlation Suggestions stay pending until an explicit Member decision; Confirmed Links record that judgment.
INSERT INTO tracegarden_capabilities (name)
VALUES ('correlation:review')
ON CONFLICT (name) DO NOTHING;

INSERT INTO tracegarden_role_capabilities (role, capability)
VALUES ('owner', 'correlation:review'), ('operator', 'correlation:review')
ON CONFLICT (role, capability) DO NOTHING;

CREATE TABLE IF NOT EXISTS tracegarden_correlation_suggestions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES tracegarden_workspaces (id),
  left_entry_id text NOT NULL REFERENCES tracegarden_timeline_entries (id) ON DELETE CASCADE,
  right_entry_id text NOT NULL REFERENCES tracegarden_timeline_entries (id) ON DELETE CASCADE,
  signals text[] NOT NULL CHECK (cardinality(signals) > 0),
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by_member_id text REFERENCES tracegarden_members (id) ON DELETE SET NULL,
  CHECK (left_entry_id <> right_entry_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tracegarden_correlation_suggestions_pair_idx
  ON tracegarden_correlation_suggestions (workspace_id, left_entry_id, right_entry_id);
CREATE INDEX IF NOT EXISTS tracegarden_correlation_suggestions_pending_idx
  ON tracegarden_correlation_suggestions (workspace_id, status, created_at, id);

CREATE TABLE IF NOT EXISTS tracegarden_confirmed_links (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES tracegarden_workspaces (id),
  suggestion_id text NOT NULL UNIQUE REFERENCES tracegarden_correlation_suggestions (id),
  left_entry_id text NOT NULL REFERENCES tracegarden_timeline_entries (id) ON DELETE CASCADE,
  right_entry_id text NOT NULL REFERENCES tracegarden_timeline_entries (id) ON DELETE CASCADE,
  confirmed_by_member_id text NOT NULL REFERENCES tracegarden_members (id),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (left_entry_id <> right_entry_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tracegarden_confirmed_links_pair_idx
  ON tracegarden_confirmed_links (workspace_id, left_entry_id, right_entry_id);
CREATE INDEX IF NOT EXISTS tracegarden_confirmed_links_entry_idx
  ON tracegarden_confirmed_links (workspace_id, left_entry_id, right_entry_id);
