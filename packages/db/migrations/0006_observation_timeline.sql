-- Normalized Pod facts and their publishable Timeline Entries share one idempotent source key.
CREATE TABLE IF NOT EXISTS tracegarden_observations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES tracegarden_workspaces (id),
  cluster_id text NOT NULL REFERENCES tracegarden_clusters (id),
  kind text NOT NULL CHECK (kind = 'Pod'),
  source_identity text NOT NULL,
  source_key text NOT NULL,
  uid text NOT NULL,
  name text NOT NULL,
  namespace text NOT NULL,
  resource_version text,
  facts jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, cluster_id, source_key)
);
CREATE INDEX IF NOT EXISTS tracegarden_observations_workspace_observed_idx
  ON tracegarden_observations (workspace_id, observed_at, id);

CREATE TABLE IF NOT EXISTS tracegarden_timeline_entries (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES tracegarden_workspaces (id),
  cluster_id text NOT NULL REFERENCES tracegarden_clusters (id),
  entry_type text NOT NULL CHECK (entry_type = 'observation'),
  observation_id text NOT NULL UNIQUE REFERENCES tracegarden_observations (id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracegarden_timeline_entries_workspace_occurred_idx
  ON tracegarden_timeline_entries (workspace_id, occurred_at, id);
