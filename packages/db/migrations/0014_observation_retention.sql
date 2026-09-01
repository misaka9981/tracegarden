-- Ordinary Observation retention is Workspace-owned and defaults to 90 days.
INSERT INTO tracegarden_capabilities (name)
VALUES ('retention:manage')
ON CONFLICT (name) DO NOTHING;

INSERT INTO tracegarden_role_capabilities (role, capability)
VALUES ('owner', 'retention:manage')
ON CONFLICT (role, capability) DO NOTHING;

CREATE TABLE IF NOT EXISTS tracegarden_retention_policies (
  workspace_id text PRIMARY KEY REFERENCES tracegarden_workspaces (id) ON DELETE CASCADE,
  retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tracegarden_retention_policies (workspace_id)
SELECT id FROM tracegarden_workspaces
ON CONFLICT (workspace_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS tracegarden_retention_policies_updated_idx
  ON tracegarden_retention_policies (workspace_id, updated_at);

CREATE OR REPLACE FUNCTION tracegarden_create_default_retention_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO tracegarden_retention_policies (workspace_id)
  VALUES (NEW.id)
  ON CONFLICT (workspace_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tracegarden_workspace_default_retention ON tracegarden_workspaces;
CREATE TRIGGER tracegarden_workspace_default_retention
AFTER INSERT ON tracegarden_workspaces
FOR EACH ROW
EXECUTE FUNCTION tracegarden_create_default_retention_policy();
