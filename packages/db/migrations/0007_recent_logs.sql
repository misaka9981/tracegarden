-- Recent Log Window grants a separate, owner-only application capability.
INSERT INTO tracegarden_capabilities (name)
VALUES ('logs:read')
ON CONFLICT (name) DO NOTHING;

INSERT INTO tracegarden_role_capabilities (role, capability)
VALUES ('owner', 'logs:read')
ON CONFLICT (role, capability) DO NOTHING;

ALTER TABLE tracegarden_audit_records
  DROP CONSTRAINT IF EXISTS tracegarden_audit_records_action_check;
ALTER TABLE tracegarden_audit_records
  ADD CONSTRAINT tracegarden_audit_records_action_check
  CHECK (action IN ('invitation.created', 'invitation.revoked', 'member.admitted', 'member.role_changed', 'log.accessed'));

ALTER TABLE tracegarden_audit_records
  DROP CONSTRAINT IF EXISTS tracegarden_audit_records_target_type_check;
ALTER TABLE tracegarden_audit_records
  ADD CONSTRAINT tracegarden_audit_records_target_type_check
  CHECK (target_type IN ('invitation', 'member', 'log_window'));
