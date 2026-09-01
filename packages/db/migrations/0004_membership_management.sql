CREATE TABLE IF NOT EXISTS tracegarden_audit_records (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES tracegarden_workspaces (id),
  actor_member_id text REFERENCES tracegarden_members (id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('invitation.created', 'invitation.revoked', 'member.admitted', 'member.role_changed')),
  target_type text NOT NULL CHECK (target_type IN ('invitation', 'member')),
  target_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracegarden_audit_records_workspace_created_idx
  ON tracegarden_audit_records (workspace_id, created_at, id);

CREATE OR REPLACE FUNCTION tracegarden_audit_records_are_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Tracegarden audit records are immutable';
END;
$$;

DROP TRIGGER IF EXISTS tracegarden_audit_records_immutable ON tracegarden_audit_records;
CREATE TRIGGER tracegarden_audit_records_immutable
  BEFORE UPDATE OR DELETE ON tracegarden_audit_records
  FOR EACH ROW EXECUTE FUNCTION tracegarden_audit_records_are_immutable();

DROP TRIGGER IF EXISTS tracegarden_audit_records_truncate_immutable ON tracegarden_audit_records;
CREATE TRIGGER tracegarden_audit_records_truncate_immutable
  BEFORE TRUNCATE ON tracegarden_audit_records
  FOR EACH STATEMENT EXECUTE FUNCTION tracegarden_audit_records_are_immutable();
