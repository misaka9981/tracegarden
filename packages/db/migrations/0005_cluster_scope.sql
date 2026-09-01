-- One explicitly configured Cluster per shared Workspace. Scope arrays are allowlists, not ambient context.
CREATE TABLE IF NOT EXISTS tracegarden_clusters (
  id text PRIMARY KEY,
  workspace_id text NOT NULL UNIQUE REFERENCES tracegarden_workspaces (id),
  name text NOT NULL,
  endpoint text NOT NULL,
  approved_namespaces text[] NOT NULL DEFAULT '{}',
  approved_resource_kinds text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tracegarden_capabilities (name)
VALUES ('cluster:configure')
ON CONFLICT (name) DO NOTHING;

INSERT INTO tracegarden_role_capabilities (role, capability)
VALUES ('owner', 'cluster:configure')
ON CONFLICT (role, capability) DO NOTHING;
