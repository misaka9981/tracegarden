-- Timeline sequence is the durable, monotonic cursor. Notifications remain commit-only hints.
-- Legacy tables only constrained cluster_id by itself, so preflight ownership before replacing those FKs.
-- Mismatches cannot be repaired safely here: changing workspace_id would silently move tenant data,
-- while deleting rows would lose payloads. An explicit repair and migration retry is required.
DO $$
DECLARE
  mismatch_count bigint;
  mismatch_details text;
BEGIN
  WITH ownership_mismatches AS (
    SELECT 'tracegarden_observations' AS table_name, observations.id AS row_id,
           observations.workspace_id, observations.cluster_id, clusters.workspace_id AS cluster_workspace_id
      FROM tracegarden_observations AS observations
      JOIN tracegarden_clusters AS clusters ON clusters.id = observations.cluster_id
     WHERE clusters.workspace_id <> observations.workspace_id
    UNION ALL
    SELECT 'tracegarden_timeline_entries' AS table_name, entries.id AS row_id,
           entries.workspace_id, entries.cluster_id, clusters.workspace_id AS cluster_workspace_id
      FROM tracegarden_timeline_entries AS entries
      JOIN tracegarden_clusters AS clusters ON clusters.id = entries.cluster_id
     WHERE entries.cluster_id IS NOT NULL
       AND clusters.workspace_id <> entries.workspace_id
    UNION ALL
    SELECT 'tracegarden_ingestion_checkpoints' AS table_name, checkpoints.workspace_id || ':' || checkpoints.cluster_id || ':' || checkpoints.namespace || ':' || checkpoints.resource_kind AS row_id,
           checkpoints.workspace_id, checkpoints.cluster_id, clusters.workspace_id AS cluster_workspace_id
      FROM tracegarden_ingestion_checkpoints AS checkpoints
      JOIN tracegarden_clusters AS clusters ON clusters.id = checkpoints.cluster_id
     WHERE clusters.workspace_id <> checkpoints.workspace_id
  )
  SELECT count(*), string_agg(format('%s id=%s workspace_id=%s cluster_id=%s cluster_workspace_id=%s', table_name, row_id, workspace_id, cluster_id, cluster_workspace_id), E'\n' ORDER BY table_name, row_id)
    INTO mismatch_count, mismatch_details
    FROM ownership_mismatches;

  IF mismatch_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('Migration 0013 blocked: %s legacy Workspace/Cluster ownership mismatch(es)', mismatch_count),
      DETAIL = mismatch_details,
      HINT = 'No rows were changed. Explicitly reconcile each listed row with its intended Workspace and Cluster without changing payloads, then rerun migration 0013.';
  END IF;
END
$$;

CREATE SEQUENCE IF NOT EXISTS tracegarden_timeline_sequence_seq AS bigint;

ALTER TABLE tracegarden_timeline_entries
  ADD COLUMN IF NOT EXISTS timeline_sequence bigint;

WITH ordered_entries AS (
  SELECT id, row_number() OVER (ORDER BY occurred_at, id)::bigint AS timeline_sequence
    FROM tracegarden_timeline_entries
   WHERE timeline_sequence IS NULL
)
UPDATE tracegarden_timeline_entries AS entries
   SET timeline_sequence = ordered_entries.timeline_sequence
  FROM ordered_entries
 WHERE entries.id = ordered_entries.id;

SELECT setval(
  'tracegarden_timeline_sequence_seq',
  COALESCE((SELECT max(timeline_sequence) FROM tracegarden_timeline_entries), 1),
  (SELECT count(*) > 0 FROM tracegarden_timeline_entries)
);

CREATE OR REPLACE FUNCTION tracegarden_next_timeline_sequence()
RETURNS bigint
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tracegarden:timeline:writer'));
  RETURN nextval('tracegarden_timeline_sequence_seq');
END;
$$;

ALTER TABLE tracegarden_timeline_entries
  ALTER COLUMN timeline_sequence SET DEFAULT tracegarden_next_timeline_sequence(),
  ALTER COLUMN timeline_sequence SET NOT NULL;

ALTER TABLE tracegarden_observations
  DROP CONSTRAINT IF EXISTS tracegarden_observations_cluster_id_fkey,
  ADD CONSTRAINT tracegarden_observations_workspace_cluster_fk
    FOREIGN KEY (workspace_id, cluster_id)
    REFERENCES tracegarden_clusters (workspace_id, id);

ALTER TABLE tracegarden_timeline_entries
  DROP CONSTRAINT IF EXISTS tracegarden_timeline_entries_cluster_id_fkey,
  ADD CONSTRAINT tracegarden_timeline_entries_workspace_cluster_fk
    FOREIGN KEY (workspace_id, cluster_id)
    REFERENCES tracegarden_clusters (workspace_id, id);

ALTER TABLE tracegarden_ingestion_checkpoints
  DROP CONSTRAINT IF EXISTS tracegarden_ingestion_checkpoints_cluster_id_fkey,
  ADD CONSTRAINT tracegarden_ingestion_checkpoints_workspace_cluster_fk
    FOREIGN KEY (workspace_id, cluster_id)
    REFERENCES tracegarden_clusters (workspace_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS tracegarden_timeline_entries_sequence_idx
  ON tracegarden_timeline_entries (timeline_sequence);

-- PostgreSQL delivers NOTIFY payloads only after the surrounding transaction commits.
CREATE OR REPLACE FUNCTION tracegarden_notify_timeline_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'tracegarden_timeline',
    json_build_object('entryId', NEW.id)::text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tracegarden_timeline_entry_notify ON tracegarden_timeline_entries;
CREATE TRIGGER tracegarden_timeline_entry_notify
AFTER INSERT ON tracegarden_timeline_entries
FOR EACH ROW
EXECUTE FUNCTION tracegarden_notify_timeline_entry();
