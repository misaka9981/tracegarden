-- Extend the Pod tracer bullet to every supported Kubernetes Observation kind.
ALTER TABLE tracegarden_observations
  DROP CONSTRAINT IF EXISTS tracegarden_observations_kind_check;

ALTER TABLE tracegarden_observations
  ADD CONSTRAINT tracegarden_observations_kind_check
  CHECK (kind IN ('Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Pod', 'Job', 'CronJob', 'Event'));

CREATE INDEX IF NOT EXISTS tracegarden_observations_identity_observed_idx
  ON tracegarden_observations (workspace_id, cluster_id, source_identity, observed_at, id);

-- A timestamp is supplied by the Cluster and can tie during one list/watch batch.
-- This sequence preserves ingestion order for recovery classification.
CREATE SEQUENCE IF NOT EXISTS tracegarden_observation_ingestion_order_seq;
ALTER TABLE tracegarden_observations
  ADD COLUMN IF NOT EXISTS ingestion_order bigint;
WITH current_order AS (
  SELECT GREATEST(COALESCE(MAX(ingestion_order), 0), 0) AS base_order
    FROM tracegarden_observations
), ordered_observations AS (
  SELECT observation.id,
         current_order.base_order + ROW_NUMBER() OVER (
           ORDER BY observation.observed_at ASC, observation.created_at ASC, observation.id ASC
         ) AS ingestion_order
    FROM tracegarden_observations observation
    CROSS JOIN current_order
   WHERE observation.ingestion_order IS NULL
)
UPDATE tracegarden_observations observation
   SET ingestion_order = ordered_observations.ingestion_order
  FROM ordered_observations
 WHERE observation.id = ordered_observations.id;
SELECT setval(
  'tracegarden_observation_ingestion_order_seq',
  COALESCE((SELECT MAX(ingestion_order) FROM tracegarden_observations), 1),
  (SELECT COUNT(*) > 0 FROM tracegarden_observations)
);
ALTER TABLE tracegarden_observations
  ALTER COLUMN ingestion_order SET DEFAULT nextval('tracegarden_observation_ingestion_order_seq'),
  ALTER COLUMN ingestion_order SET NOT NULL;
CREATE INDEX IF NOT EXISTS tracegarden_observations_identity_ingestion_idx
  ON tracegarden_observations (workspace_id, cluster_id, source_identity, ingestion_order);
