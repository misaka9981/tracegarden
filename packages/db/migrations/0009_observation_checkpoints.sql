-- One durable resourceVersion per namespace and observed kind; it is advanced with its owning Observation transaction.
CREATE TABLE IF NOT EXISTS tracegarden_ingestion_checkpoints (
  workspace_id text NOT NULL REFERENCES tracegarden_workspaces (id),
  cluster_id text NOT NULL REFERENCES tracegarden_clusters (id),
  namespace text NOT NULL,
  resource_kind text NOT NULL,
  resource_version text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, cluster_id, namespace, resource_kind)
);
