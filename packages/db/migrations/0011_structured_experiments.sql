-- Structured human Experiments are durable Timeline Entries with replaceable associations.
CREATE TABLE IF NOT EXISTS tracegarden_experiments (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES tracegarden_workspaces (id),
  created_by_member_id text NOT NULL REFERENCES tracegarden_members (id),
  hypothesis text NOT NULL,
  change text NOT NULL,
  observation text NOT NULL,
  conclusion text NOT NULL DEFAULT '',
  state text NOT NULL CHECK (state IN ('draft', 'active', 'concluded', 'abandoned')),
  tags text[] NOT NULL DEFAULT '{}',
  git_revision text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracegarden_experiments_workspace_updated_idx
  ON tracegarden_experiments (workspace_id, updated_at, id);

CREATE TABLE IF NOT EXISTS tracegarden_experiment_workloads (
  experiment_id text NOT NULL REFERENCES tracegarden_experiments (id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES tracegarden_workspaces (id),
  cluster_id text NOT NULL,
  namespace text NOT NULL,
  kind text NOT NULL,
  name text NOT NULL,
  PRIMARY KEY (experiment_id, cluster_id, namespace, kind, name)
);
CREATE INDEX IF NOT EXISTS tracegarden_experiment_workloads_workspace_idx
  ON tracegarden_experiment_workloads (workspace_id, cluster_id, namespace, kind, name);

CREATE UNIQUE INDEX IF NOT EXISTS tracegarden_clusters_workspace_id_id_idx
  ON tracegarden_clusters (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS tracegarden_experiments_workspace_id_id_idx
  ON tracegarden_experiments (workspace_id, id);
ALTER TABLE tracegarden_experiment_workloads
  ADD CONSTRAINT tracegarden_experiment_workloads_experiment_scope_fk
  FOREIGN KEY (workspace_id, experiment_id)
  REFERENCES tracegarden_experiments (workspace_id, id)
  ON DELETE CASCADE;
ALTER TABLE tracegarden_experiment_workloads
  ADD CONSTRAINT tracegarden_experiment_workloads_cluster_scope_fk
  FOREIGN KEY (workspace_id, cluster_id)
  REFERENCES tracegarden_clusters (workspace_id, id);

ALTER TABLE tracegarden_timeline_entries
  ALTER COLUMN observation_id DROP NOT NULL;
ALTER TABLE tracegarden_timeline_entries
  ALTER COLUMN cluster_id DROP NOT NULL;
ALTER TABLE tracegarden_timeline_entries
  ADD COLUMN IF NOT EXISTS experiment_id text REFERENCES tracegarden_experiments (id) ON DELETE CASCADE;
ALTER TABLE tracegarden_timeline_entries
  DROP CONSTRAINT IF EXISTS tracegarden_timeline_entries_entry_type_check;
ALTER TABLE tracegarden_timeline_entries
  ADD CONSTRAINT tracegarden_timeline_entries_entry_type_check
  CHECK (entry_type IN ('observation', 'experiment'));
ALTER TABLE tracegarden_timeline_entries
  DROP CONSTRAINT IF EXISTS tracegarden_timeline_entries_single_source_check;
ALTER TABLE tracegarden_timeline_entries
  ADD CONSTRAINT tracegarden_timeline_entries_single_source_check
  CHECK ((entry_type = 'observation' AND observation_id IS NOT NULL AND experiment_id IS NULL)
      OR (entry_type = 'experiment' AND observation_id IS NULL AND experiment_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS tracegarden_timeline_entries_experiment_id_idx
  ON tracegarden_timeline_entries (experiment_id)
  WHERE experiment_id IS NOT NULL;
