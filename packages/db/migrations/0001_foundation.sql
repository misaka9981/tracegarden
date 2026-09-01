-- Foundation schema: the migration runner records this file's id before application readiness.
CREATE TABLE IF NOT EXISTS tracegarden_runtime_status (
  id integer PRIMARY KEY CHECK (id = 1),
  web_ready boolean NOT NULL DEFAULT false,
  collector_ready boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tracegarden_runtime_status (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;
