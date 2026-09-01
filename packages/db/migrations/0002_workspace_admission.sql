CREATE TABLE IF NOT EXISTS tracegarden_workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tracegarden_external_identities (
  id text PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

CREATE TABLE IF NOT EXISTS tracegarden_members (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES tracegarden_workspaces (id),
  external_identity_id text NOT NULL UNIQUE REFERENCES tracegarden_external_identities (id),
  role text NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tracegarden_invitations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES tracegarden_workspaces (id),
  email text NOT NULL,
  email_key text NOT NULL,
  revoked_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracegarden_invitations_email_key_idx
  ON tracegarden_invitations (workspace_id, email_key);

CREATE TABLE IF NOT EXISTS tracegarden_capabilities (
  name text PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS tracegarden_role_capabilities (
  role text NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
  capability text NOT NULL REFERENCES tracegarden_capabilities (name),
  PRIMARY KEY (role, capability)
);

CREATE TABLE IF NOT EXISTS tracegarden_sessions (
  id text PRIMARY KEY,
  token text NOT NULL UNIQUE,
  member_id text NOT NULL REFERENCES tracegarden_members (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracegarden_sessions_token_idx
  ON tracegarden_sessions (token);

INSERT INTO tracegarden_workspaces (id, name)
VALUES ('workspace-single', 'Tracegarden Workspace')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tracegarden_capabilities (name)
VALUES
  ('workspace:read'),
  ('membership:manage'),
  ('timeline:read'),
  ('experiment:write')
ON CONFLICT (name) DO NOTHING;

INSERT INTO tracegarden_role_capabilities (role, capability)
VALUES
  ('owner', 'workspace:read'),
  ('owner', 'membership:manage'),
  ('owner', 'timeline:read'),
  ('owner', 'experiment:write'),
  ('operator', 'workspace:read'),
  ('operator', 'timeline:read'),
  ('operator', 'experiment:write'),
  ('viewer', 'workspace:read'),
  ('viewer', 'timeline:read')
ON CONFLICT (role, capability) DO NOTHING;
