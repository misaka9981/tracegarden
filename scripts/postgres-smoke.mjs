import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { execFileSync, spawn } from "node:child_process";
import { createCollectorRuntime } from "../dist/apps/collector/src/main.js";
import { DeterministicKubernetesAdapter, normalizeObservation, normalizePodObservation } from "../dist/packages/cluster/src/index.js";
import { PostgresDatabase, PostgresObservationStore, TimelineQueryValidationError, waitForDatabase } from "../dist/packages/db/src/index.js";
import { FakeKubernetesLogAdapter, requestRecentLogWindow } from "../dist/packages/logs/src/index.js";

const name = `tracegarden-foundation-pg-${process.pid}`;
const postgresImage = "postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7";
const databasePort = 45433;
const webPort = 43200;
const productionWebPort = 43201;
let web;
let productionWeb;
let legacyMigrationDatabase;
let logDatabase;
const databaseUrl = `postgresql://tracegarden:local-only@127.0.0.1:${databasePort}/tracegarden`;
let collector;
let collectorDatabase;
let collectorProcess;

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function imageAvailable(image) {
  try {
    docker("image", "inspect", image);
    return true;
  } catch {
    return false;
  }
}
function removeDatabase() {
  try { docker("rm", "-f", name); } catch { /* already absent */ }
}

if (!imageAvailable(postgresImage)) {
  throw new Error(`PostgreSQL smoke requires the pinned PostgreSQL image ${postgresImage}; refusing to pull it`);
}

removeDatabase();
try {
  docker("run", "--pull=never", "-d", "--name", name, "-p", `${databasePort}:5432`, "-e", "POSTGRES_DB=tracegarden", "-e", "POSTGRES_USER=tracegarden", "-e", "POSTGRES_PASSWORD=local-only", postgresImage);
  await waitForDatabase({
    ping: async () => {
      try {
        docker("exec", name, "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
  }, 10_000, 250);

  // Apply the legacy schema first so migration 0013 is tested against pre-existing data.
  const legacyClient = new pg.Client(databaseUrl);
  await legacyClient.connect();
  try {
    await legacyClient.query("BEGIN");
    await legacyClient.query(`
      CREATE TABLE IF NOT EXISTS tracegarden_schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const legacyMigrationIds = [
      "0001_foundation",
      "0002_workspace_admission",
      "0003_better_auth",
      "0004_membership_management",
      "0005_cluster_scope",
      "0006_observation_timeline",
      "0007_recent_logs",
      "0008_normalized_observations",
      "0009_observation_checkpoints",
      "0010_timeline_attention",
      "0011_structured_experiments",
    ];
    for (const migrationId of legacyMigrationIds) {
      const migrationSql = await readFile(new URL(`../dist/packages/db/migrations/${migrationId}.sql`, import.meta.url), "utf8");
      await legacyClient.query(migrationSql);
      await legacyClient.query("INSERT INTO tracegarden_schema_migrations (id) VALUES ($1)", [migrationId]);
    }
    await legacyClient.query("INSERT INTO tracegarden_workspaces (id, name) VALUES ('workspace-legacy', 'Legacy Workspace')");
    await legacyClient.query("INSERT INTO tracegarden_clusters (id, workspace_id, name, endpoint) VALUES ('legacy-cluster', 'workspace-legacy', 'Legacy Cluster', 'https://legacy-cluster.example.test')");
    await legacyClient.query(
      `INSERT INTO tracegarden_observations
         (id, workspace_id, cluster_id, kind, source_identity, source_key, uid, name, namespace, resource_version, facts, observed_at)
       VALUES ('legacy-mismatched-observation', 'workspace-single', 'legacy-cluster', 'Pod', 'legacy-source', 'legacy-source', 'legacy-uid', 'legacy-pod', 'tracegarden', '1', '{"payload":"must survive migration failure"}'::jsonb, '2026-01-01T00:00:00.000Z')`,
    );
    await legacyClient.query("COMMIT");
  } catch (error) {
    await legacyClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await legacyClient.end();
  }
  legacyMigrationDatabase = new PostgresDatabase(databaseUrl);
  await assert.rejects(
    legacyMigrationDatabase.migrate(),
    (error) => error instanceof Error
      && /database migration failed/.test(error.message)
      && error.cause instanceof Error
      && /Migration 0013 blocked: 1 legacy Workspace\/Cluster ownership mismatch/.test(error.cause.message),
  );
  const preservedLegacyClient = new pg.Client(databaseUrl);
  await preservedLegacyClient.connect();
  try {
    const preserved = await preservedLegacyClient.query(
      "SELECT workspace_id, cluster_id, facts->>'payload' AS payload FROM tracegarden_observations WHERE id = 'legacy-mismatched-observation'",
    );
    assert.deepEqual(preserved.rows, [{ workspace_id: "workspace-single", cluster_id: "legacy-cluster", payload: "must survive migration failure" }]);
    await preservedLegacyClient.query("BEGIN");
    await preservedLegacyClient.query("UPDATE tracegarden_observations SET workspace_id = 'workspace-legacy' WHERE id = 'legacy-mismatched-observation'");
    const correlationMigration = await readFile(new URL("../dist/packages/db/migrations/0012_correlation_links.sql", import.meta.url), "utf8");
    await preservedLegacyClient.query(correlationMigration);
    await preservedLegacyClient.query("INSERT INTO tracegarden_schema_migrations (id) VALUES ('0012_correlation_links')");
    await preservedLegacyClient.query(
      `INSERT INTO tracegarden_observations
         (id, workspace_id, cluster_id, kind, source_identity, source_key, uid, name, namespace, resource_version, facts, observed_at)
       VALUES
         ('legacy-correlation-observation-a', 'workspace-legacy', 'legacy-cluster', 'Pod', 'legacy-correlation-a', 'legacy-correlation-a', 'legacy-correlation-a', 'legacy-correlation-a', 'tracegarden', '1', '{"phase":"Running"}'::jsonb, '2026-01-01T00:00:01.000Z'),
         ('legacy-correlation-observation-b', 'workspace-legacy', 'legacy-cluster', 'Pod', 'legacy-correlation-b', 'legacy-correlation-b', 'legacy-correlation-b', 'legacy-correlation-b', 'tracegarden', '1', '{"phase":"Running"}'::jsonb, '2026-01-01T00:00:02.000Z')`,
    );
    await preservedLegacyClient.query(
      `INSERT INTO tracegarden_timeline_entries
         (id, workspace_id, cluster_id, entry_type, observation_id, occurred_at)
       VALUES
         ('legacy-correlation-entry-a', 'workspace-legacy', 'legacy-cluster', 'observation', 'legacy-correlation-observation-a', '2026-01-01T00:00:01.000Z'),
         ('legacy-correlation-entry-b', 'workspace-legacy', 'legacy-cluster', 'observation', 'legacy-correlation-observation-b', '2026-01-01T00:00:02.000Z')`,
    );
    await preservedLegacyClient.query(
      `INSERT INTO tracegarden_correlation_suggestions
         (id, workspace_id, left_entry_id, right_entry_id, signals, status)
       VALUES ('legacy-mismatched-correlation', 'workspace-single', 'legacy-correlation-entry-a', 'legacy-correlation-entry-b', ARRAY['time'], 'pending')`,
    );
    await preservedLegacyClient.query("COMMIT");
  } finally {
    await preservedLegacyClient.end();
  }
  await assert.rejects(
    legacyMigrationDatabase.migrate(),
    (error) => error instanceof Error
      && /database migration failed/.test(error.message)
      && error.cause instanceof Error
      && /Migration 0015 blocked: 2 legacy correlation Workspace ownership mismatch/.test(error.cause.message),
  );
  const repairedCorrelationClient = new pg.Client(databaseUrl);
  await repairedCorrelationClient.connect();
  try {
    const preservedCorrelation = await repairedCorrelationClient.query(
      "SELECT workspace_id, left_entry_id, right_entry_id FROM tracegarden_correlation_suggestions WHERE id = 'legacy-mismatched-correlation'",
    );
    assert.deepEqual(preservedCorrelation.rows, [{ workspace_id: "workspace-single", left_entry_id: "legacy-correlation-entry-a", right_entry_id: "legacy-correlation-entry-b" }]);
    await repairedCorrelationClient.query("UPDATE tracegarden_correlation_suggestions SET workspace_id = 'workspace-legacy' WHERE id = 'legacy-mismatched-correlation'");
  } finally {
    await repairedCorrelationClient.end();
  }
  await legacyMigrationDatabase.migrate();
  const cleanupLegacyClient = new pg.Client(databaseUrl);
  await cleanupLegacyClient.connect();
  try {
    await cleanupLegacyClient.query("DELETE FROM tracegarden_correlation_suggestions WHERE id = 'legacy-mismatched-correlation'");
    await cleanupLegacyClient.query("DELETE FROM tracegarden_timeline_entries WHERE id IN ('legacy-correlation-entry-a', 'legacy-correlation-entry-b')");
    await cleanupLegacyClient.query("DELETE FROM tracegarden_observations WHERE id IN ('legacy-mismatched-observation', 'legacy-correlation-observation-a', 'legacy-correlation-observation-b')");
    await cleanupLegacyClient.query("DELETE FROM tracegarden_clusters WHERE id = 'legacy-cluster'");
    await cleanupLegacyClient.query("DELETE FROM tracegarden_workspaces WHERE id = 'workspace-legacy'");
  } finally {
    await cleanupLegacyClient.end();
  }
  await legacyMigrationDatabase.close();
  legacyMigrationDatabase = undefined;

  web = spawn("bun", ["dist/apps/web/src/bun.js"], {
    env: { ...process.env, DATABASE_URL: databaseUrl, PORT: String(webPort), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  web.stdout.on("data", (chunk) => { output += chunk; });
  web.stderr.on("data", (chunk) => { output += chunk; });
  let response;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      response = await fetch(`http://127.0.0.1:${webPort}/health/readiness`);
      break;
    } catch {
      if (attempt === 39) throw new Error(`web did not become ready: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(response);
  assert.equal(response.status, 200);
  const readiness = await response.json();
  assert.equal(readiness.checks.database, "ready");
  assert.equal(readiness.checks.migrations, "ready");
  const migrationCount = docker("exec", name, "psql", "-At", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT count(*) FROM tracegarden_schema_migrations WHERE id IN ('0001_foundation', '0002_workspace_admission', '0003_better_auth', '0004_membership_management', '0005_cluster_scope', '0006_observation_timeline', '0007_recent_logs', '0008_normalized_observations', '0009_observation_checkpoints', '0010_timeline_attention', '0011_structured_experiments', '0012_correlation_links', '0013_live_timeline', '0014_observation_retention', '0015_correlation_ownership');");
  assert.equal(migrationCount, "15");
  const login = await fetch(`http://127.0.0.1:${webPort}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "identity=owner&lang=en",
  });
  assert.equal(login.status, 303);
  const session = await fetch(`http://127.0.0.1:${webPort}/api/session`, {
    headers: { cookie: login.headers.get("set-cookie") ?? "" },
  });
  assert.equal(session.status, 200);
  const sessionBody = await session.json();
  assert.equal(sessionBody.member.identity.issuer, "https://local.tracegarden.test");
  assert.equal(sessionBody.member.identity.subject, "owner");
  const ownerCookie = login.headers.get("set-cookie") ?? "";
  const retentionDefaultResponse = await fetch(`http://127.0.0.1:${webPort}/api/retention`, { headers: { cookie: ownerCookie } });
  assert.equal(retentionDefaultResponse.status, 200);
  assert.equal((await retentionDefaultResponse.json()).policy.retentionDays, 90);
  const retentionUpdateResponse = await fetch(`http://127.0.0.1:${webPort}/api/retention`, {
    method: "PUT",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ retentionDays: 30 }),
  });
  assert.equal(retentionUpdateResponse.status, 200);
  assert.equal((await retentionUpdateResponse.json()).policy.retentionDays, 30);
  const invalidRetentionResponse = await fetch(`http://127.0.0.1:${webPort}/api/retention`, {
    method: "PATCH",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ retentionDays: 0 }),
  });
  assert.equal(invalidRetentionResponse.status, 400);
  const invitationResponse = await fetch(`http://127.0.0.1:${webPort}/api/invitations`, {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ email: " INVITED@EXAMPLE.TEST " }),
  });
  assert.equal(invitationResponse.status, 201);
  const invitationBody = await invitationResponse.json();
  assert.equal(invitationBody.invitation.email, "invited@example.test");
  const revokedInvitationResponse = await fetch(`http://127.0.0.1:${webPort}/api/invitations`, {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "rejected@example.test" }),
  });
  assert.equal(revokedInvitationResponse.status, 201);
  const revokedInvitation = (await revokedInvitationResponse.json()).invitation;
  const revokeResponse = await fetch(`http://127.0.0.1:${webPort}/api/invitations/${revokedInvitation.id}/revoke`, {
    method: "POST",
    headers: { cookie: ownerCookie },
  });
  assert.equal(revokeResponse.status, 200);
  const invitedLogin = await fetch(`http://127.0.0.1:${webPort}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "identity=invited&lang=en",
  });
  assert.equal(invitedLogin.status, 303);
  const invitedSession = await fetch(`http://127.0.0.1:${webPort}/api/session`, { headers: { cookie: invitedLogin.headers.get("set-cookie") ?? "" } });
  const invitedSessionBody = await invitedSession.json();
  assert.equal(invitedSessionBody.member.role, "viewer");
  const roleResponse = await fetch(`http://127.0.0.1:${webPort}/api/members/${invitedSessionBody.member.id}/role`, {
    method: "PATCH",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ role: "operator" }),
  });
  assert.equal(roleResponse.status, 200);
  const refreshedInvitedSession = await fetch(`http://127.0.0.1:${webPort}/api/session`, { headers: { cookie: invitedLogin.headers.get("set-cookie") ?? "" } });
  const refreshedInvitedSessionBody = await refreshedInvitedSession.json();
  assert.equal(refreshedInvitedSessionBody.member.role, "operator");
  assert.ok(refreshedInvitedSessionBody.member.capabilities.includes("experiment:write"));
  assert.ok(!refreshedInvitedSessionBody.member.capabilities.includes("membership:manage"));
  assert.ok(!refreshedInvitedSessionBody.member.capabilities.includes("retention:manage"));
  const promoteInvitedOwner = await fetch(`http://127.0.0.1:${webPort}/api/members/${invitedSessionBody.member.id}/role`, {
    method: "PATCH",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ role: "owner" }),
  });
  assert.equal(promoteInvitedOwner.status, 200);
  const demoteInvitedOwner = await fetch(`http://127.0.0.1:${webPort}/api/members/${invitedSessionBody.member.id}/role`, {
    method: "PATCH",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ role: "viewer" }),
  });
  assert.equal(demoteInvitedOwner.status, 200);
  const demoteLastOwner = await fetch(`http://127.0.0.1:${webPort}/api/members/${sessionBody.member.id}/role`, {
    method: "PATCH",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ role: "viewer" }),
  });
  assert.equal(demoteLastOwner.status, 409);
  assert.deepEqual(await demoteLastOwner.json(), { error: "last_workspace_owner" });
  assert.equal((await (await fetch(`http://127.0.0.1:${webPort}/api/members`, { headers: { cookie: ownerCookie } })).json()).members.filter((member) => member.role === "owner").length, 1);
  const deniedRetentionUpdate = await fetch(`http://127.0.0.1:${webPort}/api/retention`, {
    method: "PUT",
    headers: { cookie: invitedLogin.headers.get("set-cookie") ?? "", "content-type": "application/json" },
    body: JSON.stringify({ retentionDays: 7 }),
  });
  assert.equal(deniedRetentionUpdate.status, 403);
  const clusterScope = await fetch(`http://127.0.0.1:${webPort}/api/cluster`, {
    method: "PUT",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({
      clusterId: "local-postgres-smoke",
      name: "Local deterministic Cluster",
      endpoint: "https://cluster.example.test",
      namespaces: ["tracegarden"],
      resourceKinds: ["Pod", "Deployment"],
    }),
  });
  assert.equal(clusterScope.status, 200);
  assert.equal((await clusterScope.json()).scope.clusterId, "local-postgres-smoke");
  const retentionDatabase = new PostgresDatabase(databaseUrl);
  try {
    const retentionScope = {
      workspaceId: "workspace-single",
      clusterId: "local-postgres-smoke",
      name: "Local deterministic Cluster",
      endpoint: "https://cluster.example.test",
      namespaces: ["tracegarden"],
      resourceKinds: ["Pod"],
    };
    const retentionObservation = (uid, observedAt) => normalizePodObservation(retentionScope, {
      kind: "Pod",
      metadata: { name: uid, namespace: "tracegarden", uid, resourceVersion: uid },
      status: { phase: "Running" },
    }, observedAt);
    const deletedCandidate = await retentionDatabase.timeline.recordObservation(retentionObservation("retention-pg-deleted", "2025-12-31T00:00:00.000Z"));
    const protectedCandidate = await retentionDatabase.timeline.recordObservation(retentionObservation("retention-pg-protected", "2025-12-31T00:00:00.000Z"));
    await retentionDatabase.timeline.recordObservation(retentionObservation("retention-pg-boundary", "2026-01-01T00:00:00.000Z"));
    const retentionExperiment = await retentionDatabase.experiments.createExperiment("workspace-single", sessionBody.member.id, {
      hypothesis: "retention protection", change: "none", observation: "context", conclusion: "", state: "active", tags: [], workloads: [], gitRevision: null,
    });
    const retentionClient = new pg.Client(databaseUrl);
    await retentionClient.connect();
    try {
      await retentionClient.query(
        `INSERT INTO tracegarden_correlation_suggestions (id, workspace_id, left_entry_id, right_entry_id, signals, status)
         VALUES ('retention-protected-suggestion', 'workspace-single', $1, $2, ARRAY['time'], 'confirmed')`,
        [protectedCandidate.entry.id, retentionExperiment.timelineEntryId],
      );
      await retentionClient.query(
        `INSERT INTO tracegarden_confirmed_links (id, workspace_id, suggestion_id, left_entry_id, right_entry_id, confirmed_by_member_id)
         VALUES ('retention-protected-link', 'workspace-single', 'retention-protected-suggestion', $1, $2, $3)`,
        [protectedCandidate.entry.id, retentionExperiment.timelineEntryId, sessionBody.member.id],
      );
    } finally {
      await retentionClient.end();
    }
    await retentionDatabase.timeline.updateRetentionPolicy("workspace-single", 1);
    const retentionCleanup = await retentionDatabase.timeline.cleanupRetention("workspace-single", "2026-01-02T00:00:00.000Z");
    assert.equal(retentionCleanup.deletedObservations, 1);
    assert.equal(retentionCleanup.protectedObservations, 1);
    assert.equal(retentionCleanup.deletedTimelineEntries, 1);
    assert.equal(await retentionDatabase.timeline.getTimelineEntry("workspace-single", deletedCandidate.entry.id), null);
    assert.ok(await retentionDatabase.timeline.getTimelineEntry("workspace-single", protectedCandidate.entry.id));
    assert.equal((await retentionDatabase.timeline.cleanupRetention("workspace-single", "2026-01-02T00:00:00.000Z")).deletedObservations, 0);
    await retentionDatabase.timeline.recordObservation(retentionObservation("retention-pg-partial", "2025-12-31T00:00:00.000Z"));
    const retentionFailureClient = new pg.Client(databaseUrl);
    await retentionFailureClient.connect();
    try {
      await retentionFailureClient.query("CREATE OR REPLACE FUNCTION tracegarden_test_fail_retention_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retention delete failed'; END; $$; CREATE TRIGGER tracegarden_test_fail_retention_delete BEFORE DELETE ON tracegarden_observations FOR EACH ROW EXECUTE FUNCTION tracegarden_test_fail_retention_delete();");
    } finally {
      await retentionFailureClient.end();
    }
    const partialFailure = await retentionDatabase.timeline.cleanupRetention("workspace-single", "2026-01-02T00:00:00.000Z");
    assert.equal(partialFailure.failures, 1);
    assert.equal(partialFailure.deletedObservations, 0);
    const retentionTriggerCleanupClient = new pg.Client(databaseUrl);
    await retentionTriggerCleanupClient.connect();
    try {
      await retentionTriggerCleanupClient.query("DROP TRIGGER tracegarden_test_fail_retention_delete ON tracegarden_observations; DROP FUNCTION tracegarden_test_fail_retention_delete();");
    } finally {
      await retentionTriggerCleanupClient.end();
    }
    const recoveredPartialFailure = await retentionDatabase.timeline.cleanupRetention("workspace-single", "2026-01-02T00:00:00.000Z");
    assert.equal(recoveredPartialFailure.failures, 0);
    assert.equal(recoveredPartialFailure.deletedObservations, 1);
    const retentionCleanupClient = new pg.Client(databaseUrl);
    await retentionCleanupClient.connect();
    try {
      await retentionCleanupClient.query("DELETE FROM tracegarden_confirmed_links WHERE id = 'retention-protected-link'");
      await retentionCleanupClient.query("DELETE FROM tracegarden_correlation_suggestions WHERE id = 'retention-protected-suggestion'");
      await retentionCleanupClient.query("DELETE FROM tracegarden_experiments WHERE id = $1", [retentionExperiment.id]);
      await retentionCleanupClient.query("DELETE FROM tracegarden_observations WHERE source_identity IN ('local-postgres-smoke:retention-pg-protected', 'local-postgres-smoke:retention-pg-boundary', 'local-postgres-smoke:retention-pg-partial')");
    } finally {
      await retentionCleanupClient.end();
    }
  } finally {
    await retentionDatabase.close();
  }
  let failRetentionTransaction = true;
  const failingRetentionClient = {
    query: async (sql) => {
      if (sql.includes("tracegarden_retention_policies") && (sql.includes("RETURNING") || sql.includes("SELECT workspace_id, retention_days"))) {
        return { rows: [{ workspace_id: "workspace-single", retention_days: 1, updated_at: "2026-01-01T00:00:00.000Z" }], rowCount: 1 };
      }
      if (sql.startsWith("WITH candidates")) {
        if (failRetentionTransaction) {
          failRetentionTransaction = false;
          throw new Error("simulated retention transaction failure");
        }
        return { rows: [{ candidates: "1", eligible_observations: "1", deleted_observations: "1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const failingRetentionPool = {
    query: async (sql) => sql.includes("SELECT workspace_id, retention_days")
      ? { rows: [{ workspace_id: "workspace-single", retention_days: 1, updated_at: "2026-01-01T00:00:00.000Z" }], rowCount: 1 }
      : { rows: [], rowCount: 0 },
    connect: async () => failingRetentionClient,
  };
  const failingRetentionStore = new PostgresObservationStore(async () => failingRetentionPool);
  const failedRetentionCleanup = await failingRetentionStore.cleanupRetention("workspace-single", "2026-01-02T00:00:00.000Z");
  assert.equal(failedRetentionCleanup.failures, 1);
  assert.equal(failedRetentionCleanup.deletedObservations, 0);
  const recoveredRetentionCleanup = await failingRetentionStore.cleanupRetention("workspace-single", "2026-01-02T00:00:00.000Z");
  assert.equal(recoveredRetentionCleanup.failures, 0);
  assert.equal(recoveredRetentionCleanup.deletedObservations, 1);
  const experimentCreateResponse = await fetch(`http://127.0.0.1:${webPort}/api/experiments`, {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({
      hypothesis: "**Markdown hypothesis**",
      change: "adjust Deployment",
      observation: "Pod became ready",
      conclusion: "",
      state: "active",
      tags: ["smoke", "markdown"],
      workloads: [{ clusterId: "local-postgres-smoke", namespace: "tracegarden", kind: "Deployment", name: "api" }],
      gitRevision: "abc123",
    }),
  });
  assert.equal(experimentCreateResponse.status, 201);
  const experiment = (await experimentCreateResponse.json()).experiment;
  assert.equal(experiment.workspaceId, "workspace-single");
  assert.equal(experiment.hypothesis, "**Markdown hypothesis**");
  const invalidAssociation = await fetch(`http://127.0.0.1:${webPort}/api/experiments`, {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ hypothesis: "invalid", change: "invalid", observation: "invalid", conclusion: "", state: "active", tags: [], workloads: [{ clusterId: "local-postgres-smoke", namespace: "bad namespace", kind: "Deployment", name: "bad name" }], gitRevision: "not a git revision" }),
  });
  assert.equal(invalidAssociation.status, 400);
  docker("exec", name, "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", "INSERT INTO tracegarden_workspaces (id, name) VALUES ('workspace-other', 'Other Workspace') ON CONFLICT (id) DO NOTHING; INSERT INTO tracegarden_clusters (id, workspace_id, name, endpoint) VALUES ('other-workspace-cluster', 'workspace-other', 'Other Cluster', 'https://other-cluster.example.test') ON CONFLICT (id) DO NOTHING;");
  try {
    let crossWorkspaceObservationRejected = false;
    try {
      docker("exec", name, "psql", "-v", "ON_ERROR_STOP=1", "-U", "tracegarden", "-d", "tracegarden", "-c", "BEGIN; INSERT INTO tracegarden_observations (id, workspace_id, cluster_id, kind, source_identity, source_key, uid, name, namespace, resource_version, facts, observed_at) VALUES ('cross-workspace-observation', 'workspace-single', 'other-workspace-cluster', 'Pod', 'cross-workspace', 'cross-workspace', 'cross-workspace', 'cross-workspace', 'tracegarden', '1', '{}'::jsonb, now()); ROLLBACK;");
    } catch {
      crossWorkspaceObservationRejected = true;
    }
    assert.equal(crossWorkspaceObservationRejected, true);
    let crossWorkspaceCheckpointRejected = false;
    try {
      docker("exec", name, "psql", "-v", "ON_ERROR_STOP=1", "-U", "tracegarden", "-d", "tracegarden", "-c", "BEGIN; INSERT INTO tracegarden_ingestion_checkpoints (workspace_id, cluster_id, namespace, resource_kind, resource_version) VALUES ('workspace-single', 'other-workspace-cluster', 'tracegarden', 'Pod', '1'); ROLLBACK;");
    } catch {
      crossWorkspaceCheckpointRejected = true;
    }
    assert.equal(crossWorkspaceCheckpointRejected, true);
    const ownershipDatabase = new PostgresDatabase(databaseUrl);
    try {
      const mismatchedScope = {
        workspaceId: "workspace-single",
        clusterId: "other-workspace-cluster",
        name: "Mismatched Cluster",
        endpoint: "https://other-cluster.example.test",
        namespaces: ["tracegarden"],
        resourceKinds: ["Pod"],
      };
      await assert.rejects(
        ownershipDatabase.timeline.recordObservation(normalizePodObservation(mismatchedScope, {
          kind: "Pod",
          metadata: { name: "mismatched-observation", namespace: "tracegarden", uid: "mismatched-observation", resourceVersion: "1" },
          status: { phase: "Running" },
        })),
        (error) => error instanceof Error && error.cause instanceof Error && /does not belong/.test(error.cause.message),
      );
      const mismatchedCheckpoint = {
        workspaceId: "workspace-single",
        clusterId: "other-workspace-cluster",
        namespace: "tracegarden",
        resourceKind: "Pod",
        resourceVersion: "1",
      };
      await assert.rejects(
        ownershipDatabase.timeline.recordObservationsAndCheckpoint([], mismatchedCheckpoint),
        (error) => error instanceof Error && error.cause instanceof Error && /does not belong/.test(error.cause.message),
      );
      await assert.rejects(
        ownershipDatabase.timeline.advanceIngestionCheckpoint(mismatchedCheckpoint),
        (error) => error instanceof Error && error.cause instanceof Error && /does not belong/.test(error.cause.message),
      );
      await assert.rejects(
        ownershipDatabase.timeline.clearIngestionCheckpoint(mismatchedCheckpoint),
        (error) => error instanceof Error && error.cause instanceof Error && /does not belong/.test(error.cause.message),
      );
      const validCheckpoint = { ...mismatchedCheckpoint, clusterId: "local-postgres-smoke" };
      await ownershipDatabase.timeline.advanceIngestionCheckpoint(validCheckpoint);
      await assert.rejects(
        ownershipDatabase.timeline.clearIngestionCheckpoint(mismatchedCheckpoint),
        (error) => error instanceof Error && error.cause instanceof Error && /does not belong/.test(error.cause.message),
      );
      assert.equal((await ownershipDatabase.timeline.getIngestionCheckpoint("workspace-single", "local-postgres-smoke", "Pod", "tracegarden"))?.resourceVersion, "1");
      await ownershipDatabase.timeline.clearIngestionCheckpoint(validCheckpoint);
      assert.equal(await ownershipDatabase.timeline.getIngestionCheckpoint("workspace-single", "local-postgres-smoke", "Pod", "tracegarden"), null);
    } finally {
      await ownershipDatabase.close();
    }
    const crossWorkspaceAssociation = await fetch(`http://127.0.0.1:${webPort}/api/experiments`, {
      method: "POST",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      body: JSON.stringify({ hypothesis: "cross workspace", change: "cross workspace", observation: "cross workspace", conclusion: "", state: "active", tags: [], workloads: [{ clusterId: "other-workspace-cluster", namespace: "tracegarden", kind: "Deployment", name: "api" }] }),
    });
    assert.equal(crossWorkspaceAssociation.status, 400);
  } finally {
    docker("exec", name, "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", "DELETE FROM tracegarden_clusters WHERE id = 'other-workspace-cluster'; DELETE FROM tracegarden_workspaces WHERE id = 'workspace-other';");
  }
  const experimentUpdateResponse = await fetch(`http://127.0.0.1:${webPort}/api/experiments/${experiment.id}`, {
    method: "PATCH",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({
      conclusion: "verified",
      state: "concluded",
      tags: ["verified"],
      workloads: [{ clusterId: "local-postgres-smoke", namespace: "tracegarden", kind: "Deployment", name: "worker" }],
    }),
  });
  assert.equal(experimentUpdateResponse.status, 200);
  const updatedExperiment = (await experimentUpdateResponse.json()).experiment;
  assert.equal(updatedExperiment.id, experiment.id);
  assert.equal(updatedExperiment.timelineEntryId, experiment.timelineEntryId);
  assert.deepEqual(updatedExperiment.workloads, [{ clusterId: "local-postgres-smoke", namespace: "tracegarden", kind: "Deployment", name: "worker" }]);
  const invalidExperimentTransition = await fetch(`http://127.0.0.1:${webPort}/api/experiments/${experiment.id}`, {
    method: "PATCH",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ state: "active" }),
  });
  assert.equal(invalidExperimentTransition.status, 409);
  docker("exec", name, "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", "CREATE OR REPLACE FUNCTION tracegarden_test_fail_experiment_timeline() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'experiment timeline write failed'; END; $$; CREATE TRIGGER tracegarden_test_fail_experiment_timeline BEFORE INSERT ON tracegarden_timeline_entries FOR EACH ROW WHEN (NEW.entry_type = 'experiment') EXECUTE FUNCTION tracegarden_test_fail_experiment_timeline();");
  try {
    const failedExperimentCreate = await fetch(`http://127.0.0.1:${webPort}/api/experiments`, {
      method: "POST",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      body: JSON.stringify({ hypothesis: "rollback", change: "rollback", observation: "rollback", conclusion: "", state: "active", tags: [], workloads: [] }),
    });
    assert.equal(failedExperimentCreate.status, 503);
  } finally {
    docker("exec", name, "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", "DROP TRIGGER tracegarden_test_fail_experiment_timeline ON tracegarden_timeline_entries; DROP FUNCTION tracegarden_test_fail_experiment_timeline();");
  }
  const experimentCount = docker("exec", name, "psql", "-At", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT count(*) FROM tracegarden_experiments;");
  assert.equal(experimentCount, "1");
  const retrievedExperiment = await fetch(`http://127.0.0.1:${webPort}/api/experiments/${experiment.id}`, { headers: { cookie: ownerCookie } });
  assert.equal((await retrievedExperiment.json()).experiment.id, experiment.id);
  logDatabase = new PostgresDatabase(databaseUrl);
  const postgresLogBody = "postgres-protected-log-body";
  const postgresLog = await requestRecentLogWindow({
    member: { id: sessionBody.member.id, workspaceId: sessionBody.member.workspaceId, capabilities: sessionBody.member.capabilities },
    scope: {
      workspaceId: "workspace-single",
      clusterId: "local-postgres-smoke",
      name: "Local deterministic Cluster",
      endpoint: "https://cluster.example.test",
      namespaces: ["tracegarden"],
      resourceKinds: ["Pod"],
    },
    input: { clusterId: "local-postgres-smoke", namespace: "tracegarden", pod: "api-0", container: "app", tail: 1 },
    adapter: new FakeKubernetesLogAdapter([{
      clusterId: "local-postgres-smoke",
      namespace: "tracegarden",
      pod: "api-0",
      container: "app",
      tail: 1,
      lines: [postgresLogBody],
    }]),
    auditStore: logDatabase.admission,
  });
  assert.equal(postgresLog.body, postgresLogBody);
  const postgresAuditMetadata = docker("exec", name, "psql", "-At", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT coalesce(string_agg(metadata::text, ' '), '') FROM tracegarden_audit_records;");
  assert.doesNotMatch(postgresAuditMetadata, /postgres-protected-log-body/);
  const clusterCount = docker("exec", name, "psql", "-At", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT count(*) FROM tracegarden_clusters;");
  assert.equal(clusterCount, "1");

  let collectorOutput = "";
  collectorProcess = spawn(process.execPath, ["dist/apps/collector/src/main.js"], {
    env: { ...process.env, DATABASE_URL: databaseUrl, COLLECTOR_PORT: "43211", HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  collectorProcess.stdout.on("data", (chunk) => { collectorOutput += chunk; });
  collectorProcess.stderr.on("data", (chunk) => { collectorOutput += chunk; });
  let collectorReadiness;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      collectorReadiness = await fetch("http://127.0.0.1:43211/health/readiness");
      break;
    } catch {
      if (attempt === 39) throw new Error(`collector did not become ready: ${collectorOutput}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(collectorReadiness);
  assert.equal(collectorReadiness.status, 503);
  assert.equal((await collectorReadiness.json()).checks.collector, "not-ready");
  assert.match(collectorOutput, /initial collection completed/);

  collectorDatabase = new PostgresDatabase(databaseUrl);
  const observationScope = {
    workspaceId: "workspace-single",
    clusterId: "local-postgres-smoke",
    name: "Local deterministic Cluster",
    endpoint: "https://cluster.example.test",
    namespaces: ["tracegarden"],
    resourceKinds: ["Pod"],
  };
  const deterministicPod = new DeterministicKubernetesAdapter([{
    kind: "Pod",
    metadata: { name: "api", namespace: "tracegarden", uid: "pod-uid-1", resourceVersion: "7" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }]);
  collector = await createCollectorRuntime({ port: 43203, host: "127.0.0.1", scope: observationScope, adapter: deterministicPod, observationStore: collectorDatabase.timeline });
  const firstObservation = await collector.collectObservations();
  assert.equal(firstObservation.length, 1);
  assert.equal(firstObservation[0].duplicate, false);
  assert.equal(firstObservation[0].entry.workspaceId, "workspace-single");
  assert.equal(firstObservation[0].entry.clusterId, "local-postgres-smoke");
  assert.equal(firstObservation[0].observation.sourceIdentity, "local-postgres-smoke:pod-uid-1");
  assert.equal(firstObservation[0].observation.phase, "Running");
  assert.equal(firstObservation[0].observation.ready, true);
  assert.doesNotMatch(JSON.stringify(firstObservation[0]), /conditions/);
  const duplicateObservation = await collector.collectObservations();
  assert.equal(duplicateObservation[0].duplicate, true);
  assert.equal(await collectorDatabase.timeline.countObservations("workspace-single"), 1);
  assert.equal(await collectorDatabase.timeline.countTimelineEntries("workspace-single"), 2);
  const deploymentScope = { ...observationScope, resourceKinds: ["Deployment"] };
  const deploymentStates = [
    { availableReplicas: 2, readyReplicas: 2 },
    { availableReplicas: 1, readyReplicas: 1 },
    { availableReplicas: 2, readyReplicas: 2 },
  ].map((status, index) => normalizeObservation(deploymentScope, {
    kind: "Deployment",
    metadata: { name: "api-deployment", namespace: "tracegarden", uid: "deployment-uid-1", resourceVersion: String(index + 1) },
    spec: { replicas: 2 },
    status,
  }, "2026-01-01T00:00:00.000Z"));
  const deploymentPersisted = await collectorDatabase.timeline.recordObservations(deploymentStates);
  assert.deepEqual(deploymentPersisted.map(({ observation }) => observation.classification), ["change", "attention", "recovery"]);
  assert.equal(deploymentPersisted[2].entry.recoveryOf, deploymentPersisted[1].observation.sourceKey);
  assert.equal(deploymentPersisted[1].observation.attentionReason, "deployment_replicas_unavailable");
  const duplicateAttentionObservation = normalizePodObservation(observationScope, {
    kind: "Pod",
    metadata: { name: "api", namespace: "tracegarden", uid: "pod-uid-1", resourceVersion: "7" },
    status: { phase: "Pending", conditions: [{ type: "Ready", status: "False" }] },
  }, "2099-09-01T00:00:00.000Z");
  const duplicateAttentionResult = await collectorDatabase.timeline.recordObservation(duplicateAttentionObservation);
  assert.equal(duplicateAttentionResult.duplicate, true);
  assert.equal(duplicateAttentionResult.entry.attention, false);
  assert.deepEqual(await collectorDatabase.timeline.listTimelineEntries("workspace-single", { limit: 10, name: "api" }), {
    entries: [duplicateAttentionResult.entry],
    nextCursor: null,
  });
  docker("exec", name, "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", "CREATE OR REPLACE FUNCTION tracegarden_test_fail_timeline() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'timeline write failed'; END; $$; CREATE TRIGGER tracegarden_test_fail_timeline BEFORE INSERT ON tracegarden_timeline_entries FOR EACH ROW EXECUTE FUNCTION tracegarden_test_fail_timeline();");
  const failingPodAdapter = new DeterministicKubernetesAdapter([{
    kind: "Pod",
    metadata: { name: "api-failure", namespace: "tracegarden", uid: "pod-uid-2", resourceVersion: "8" },
    status: { phase: "Pending" },
  }]);
  try {
    await assert.rejects(createCollectorRuntime({ port: 43210, host: "127.0.0.1", scope: observationScope, adapter: failingPodAdapter, observationStore: collectorDatabase.timeline, collectOnStart: true }), /Collector recovery boundary/);
  } finally {
    docker("exec", name, "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", "DROP TRIGGER tracegarden_test_fail_timeline ON tracegarden_timeline_entries; DROP FUNCTION tracegarden_test_fail_timeline();");
  }
  assert.equal(await collectorDatabase.timeline.countObservations("workspace-single"), 4);
  assert.equal(await collectorDatabase.timeline.countTimelineEntries("workspace-single"), 5);
  // Checkpoint writes remain transactional and compare opaque and large numeric versions safely.
  await collectorDatabase.timeline.recordObservationsAndCheckpoint([firstObservation[0].observation], {
    workspaceId: observationScope.workspaceId,
    clusterId: "local-postgres-smoke",
    namespace: "tracegarden",
    resourceKind: "Pod",
    resourceVersion: "7",
  });
  assert.equal((await collectorDatabase.timeline.getIngestionCheckpoint("workspace-single", "local-postgres-smoke", "Pod", "tracegarden"))?.resourceVersion, "7");
  await collectorDatabase.timeline.recordObservationsAndCheckpoint([], {
    workspaceId: observationScope.workspaceId,
    clusterId: "local-postgres-smoke",
    namespace: "tracegarden",
    resourceKind: "Pod",
    resourceVersion: "opaque-1",
  });
  await collectorDatabase.timeline.recordObservationsAndCheckpoint([], {
    workspaceId: observationScope.workspaceId,
    clusterId: "local-postgres-smoke",
    namespace: "tracegarden",
    resourceKind: "Pod",
    resourceVersion: "opaque-2",
  });
  assert.equal((await collectorDatabase.timeline.getIngestionCheckpoint("workspace-single", "local-postgres-smoke", "Pod", "tracegarden"))?.resourceVersion, "opaque-2");
  await collectorDatabase.timeline.recordObservationsAndCheckpoint([], {
    workspaceId: observationScope.workspaceId,
    clusterId: "local-postgres-smoke",
    namespace: "tracegarden",
    resourceKind: "Pod",
    resourceVersion: "9007199254740993",
  });
  await collectorDatabase.timeline.recordObservationsAndCheckpoint([], {
    workspaceId: observationScope.workspaceId,
    clusterId: "local-postgres-smoke",
    namespace: "tracegarden",
    resourceKind: "Pod",
    resourceVersion: "9007199254740992",
  });
  assert.equal((await collectorDatabase.timeline.getIngestionCheckpoint("workspace-single", "local-postgres-smoke", "Pod", "tracegarden"))?.resourceVersion, "9007199254740993");
  await collectorDatabase.timeline.recordObservationsAndCheckpoint([firstObservation[0].observation], {
    workspaceId: observationScope.workspaceId,
    clusterId: observationScope.clusterId,
    namespace: "tracegarden",
    resourceKind: "Pod",
    resourceVersion: "7",
  });
  assert.equal((await collectorDatabase.timeline.getIngestionCheckpoint("workspace-single", "local-postgres-smoke", "Pod", "tracegarden"))?.resourceVersion, "9007199254740993");
  await collectorDatabase.timeline.recordObservationsAndCheckpoint([], {
    workspaceId: observationScope.workspaceId,
    clusterId: observationScope.clusterId,
    namespace: "tracegarden",
    resourceKind: "Pod",
    resourceVersion: "opaque-1",
  });
  await collectorDatabase.timeline.recordObservationsAndCheckpoint([], {
    workspaceId: observationScope.workspaceId,
    clusterId: observationScope.clusterId,
    namespace: "tracegarden",
    resourceKind: "Pod",
    resourceVersion: "opaque-2",
  });
  assert.equal((await collectorDatabase.timeline.getIngestionCheckpoint("workspace-single", "local-postgres-smoke", "Pod", "tracegarden"))?.resourceVersion, "opaque-2");
  await collectorDatabase.timeline.recordObservationsAndCheckpoint([], {
    workspaceId: observationScope.workspaceId,
    clusterId: observationScope.clusterId,
    namespace: "tracegarden",
    resourceKind: "Pod",
    resourceVersion: "9007199254740993",
  });
  await collectorDatabase.timeline.recordObservationsAndCheckpoint([], {
    workspaceId: observationScope.workspaceId,
    clusterId: observationScope.clusterId,
    namespace: "tracegarden",
    resourceKind: "Pod",
    resourceVersion: "9007199254740992",
  });
  assert.equal((await collectorDatabase.timeline.getIngestionCheckpoint("workspace-single", "local-postgres-smoke", "Pod", "tracegarden"))?.resourceVersion, "9007199254740993");
  const timelineResponse = await fetch(`http://127.0.0.1:${webPort}/api/timeline?limit=10`, { headers: { cookie: ownerCookie } });
  assert.equal(timelineResponse.status, 200);
  const timelineBody = await timelineResponse.json();
  assert.equal(timelineBody.entries.length, 5);
  assert.ok(timelineBody.entries.some((entry) => entry.entryType === "observation" && entry.observation.name === "api"));
  assert.ok(timelineBody.entries.some((entry) => entry.entryType === "observation" && entry.observation.name === "api-deployment" && entry.observation.classification === "recovery"));
  assert.ok(timelineBody.entries.some((entry) => entry.entryType === "experiment" && entry.experiment.id === experiment.id));
  const timelinePage = await fetch(`http://127.0.0.1:${webPort}/app?lang=en`, { headers: { cookie: ownerCookie } });
  assert.match(await timelinePage.text(), /Pod Observation/);
  const timelinePageChinese = await fetch(`http://127.0.0.1:${webPort}/app?lang=zh-CN`, { headers: { cookie: ownerCookie } });
  assert.match(await timelinePageChinese.text(), /已提交的 Kubernetes Observation 会出现在这里/);
  const unauthorizedStream = await fetch(`http://127.0.0.1:${webPort}/api/timeline/stream`);
  assert.equal(unauthorizedStream.status, 401);
  const streamController = new AbortController();
  const authorizedStream = await fetch(`http://127.0.0.1:${webPort}/api/timeline/stream`, { headers: { cookie: ownerCookie }, signal: streamController.signal });
  assert.equal(authorizedStream.status, 200);
  assert.equal(authorizedStream.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const streamReader = authorizedStream.body.getReader();
  const readyChunk = await streamReader.read();
  const readyText = new TextDecoder().decode(readyChunk.value);
  assert.match(readyText, /event: ready/);
  assert.doesNotMatch(readyText, /api-deployment|facts|observation/);
  await streamReader.cancel();
  streamController.abort();
  const timelineStore = collectorDatabase.timeline;
  const timelineHints = [];
  const unsubscribeTimeline = await timelineStore.subscribeTimeline((hint) => timelineHints.push(hint));
  const liveObservation = normalizePodObservation(observationScope, {
    kind: "Pod",
    metadata: { name: "live-entry", namespace: "tracegarden", uid: "pod-uid-live", resourceVersion: "9" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }, "2099-10-01T00:00:00.000Z");
  const liveResult = await timelineStore.recordObservation(liveObservation);
  assert.deepEqual(timelineHints, [{ entryId: liveResult.entry.id }]);
  assert.doesNotMatch(JSON.stringify(timelineHints), /Running|live-entry/);
  const hintsBeforeRollback = timelineHints.length;
  docker("exec", name, "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", "CREATE OR REPLACE FUNCTION tracegarden_test_fail_live_timeline() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'live timeline write failed'; END; $$; CREATE TRIGGER tracegarden_test_fail_live_timeline BEFORE INSERT ON tracegarden_timeline_entries FOR EACH ROW EXECUTE FUNCTION tracegarden_test_fail_live_timeline();");
  try {
    await assert.rejects(timelineStore.recordObservation(normalizePodObservation(observationScope, {
      kind: "Pod",
      metadata: { name: "rolled-back-live-entry", namespace: "tracegarden", uid: "pod-uid-rolled-back", resourceVersion: "10" },
      status: { phase: "Running" },
    }, "2099-10-01T00:00:01.000Z")), /persistence failed/);
    assert.equal(timelineHints.length, hintsBeforeRollback);
  } finally {
    docker("exec", name, "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", "DROP TRIGGER tracegarden_test_fail_live_timeline ON tracegarden_timeline_entries; DROP FUNCTION tracegarden_test_fail_live_timeline();");
  }
  const recoveryBase = await timelineStore.listTimelineEntries("workspace-single", { limit: 100 }, sessionBody.member.id);
  assert.ok(recoveryBase.resumeCursor);
  const disconnectedHints = [];
  const unsubscribeDisconnected = await timelineStore.subscribeTimeline((hint) => disconnectedHints.push(hint));
  await unsubscribeDisconnected();
  const missedObservation = normalizePodObservation(observationScope, {
    kind: "Pod",
    metadata: { name: "missed-live-entry", namespace: "tracegarden", uid: "pod-uid-missed-live", resourceVersion: "11" },
    status: { phase: "Running" },
  }, "2099-10-01T00:00:01.000Z");
  const missedResult = await timelineStore.recordObservation(missedObservation);
  assert.deepEqual(disconnectedHints, []);
  const recoveredPage = await timelineStore.listTimelineEntries("workspace-single", { limit: 100, cursor: recoveryBase.resumeCursor }, sessionBody.member.id);
  assert.deepEqual(recoveredPage.entries.map((entry) => entry.id), [missedResult.entry.id]);
  const reconnectHints = [];
  const unsubscribeReconnected = await timelineStore.subscribeTimeline((hint) => reconnectHints.push(hint));
  const duplicateMissed = await timelineStore.recordObservation(missedObservation);
  assert.equal(duplicateMissed.duplicate, true);
  assert.deepEqual(reconnectHints, []);
  const reconnectedObservation = normalizePodObservation(observationScope, {
    kind: "Pod",
    metadata: { name: "reconnected-live-entry", namespace: "tracegarden", uid: "pod-uid-reconnected-live", resourceVersion: "12" },
    status: { phase: "Running" },
  }, "2099-10-01T00:00:02.000Z");
  const reconnectedResult = await timelineStore.recordObservation(reconnectedObservation);
  assert.deepEqual(reconnectHints, [{ entryId: reconnectedResult.entry.id }]);
  await unsubscribeReconnected();
  const concurrencyClient = new pg.Client(databaseUrl);
  await concurrencyClient.connect();
  const concurrencyObservationId = `concurrency-observation-${process.pid}`;
  const concurrencyEntryId = `concurrency-entry-${process.pid}`;
  try {
    await concurrencyClient.query("BEGIN");
    await concurrencyClient.query("SELECT pg_advisory_xact_lock(hashtext('tracegarden:timeline:writer'))");
    await concurrencyClient.query(
      `INSERT INTO tracegarden_observations
         (id, workspace_id, cluster_id, kind, source_identity, source_key, uid, name, namespace, resource_version, facts, observed_at)
       VALUES ($1, 'workspace-single', $2, 'Pod', $3, $3, $3, 'concurrency-before', 'tracegarden', '1', '{}'::jsonb, '2099-11-01T00:00:00.000Z')`,
      [concurrencyObservationId, observationScope.clusterId, concurrencyObservationId],
    );
    const sequenceA = (await concurrencyClient.query(
      `INSERT INTO tracegarden_timeline_entries (id, workspace_id, cluster_id, entry_type, observation_id, occurred_at)
       VALUES ($1, 'workspace-single', $2, 'observation', $3, '2099-11-01T00:00:00.000Z')
       RETURNING timeline_sequence`,
      [concurrencyEntryId, observationScope.clusterId, concurrencyObservationId],
    )).rows[0]?.timeline_sequence;
    assert.ok(sequenceA);
    const blockedObservation = normalizePodObservation(observationScope, {
      kind: "Pod",
      metadata: { name: "concurrency-after", namespace: "tracegarden", uid: "concurrency-after", resourceVersion: "1" },
      status: { phase: "Running" },
    }, "2099-11-01T00:00:01.000Z");
    const blockedWrite = timelineStore.recordObservationsAndCheckpoint([blockedObservation], {
      workspaceId: "workspace-single",
      clusterId: observationScope.clusterId,
      namespace: "tracegarden",
      resourceKind: "Pod",
      resourceVersion: "concurrency-1",
    });
    await concurrencyClient.query("COMMIT");
    const blockedResult = (await blockedWrite)[0];
    assert.ok(blockedResult);
    assert.ok(BigInt(blockedResult.entry.timelineSequence) > BigInt(sequenceA));
  } finally {
    await concurrencyClient.query("ROLLBACK").catch(() => undefined);
    await concurrencyClient.end();
  }

  const raceClient = new pg.Client(databaseUrl);
  await raceClient.connect();
  const raceQuery = raceClient.query.bind(raceClient);
  let pageReadResolve;
  const pageRead = new Promise((resolve) => { pageReadResolve = resolve; });
  let releasePageRead;
  const pageReadReleased = new Promise((resolve) => { releasePageRead = resolve; });
  let pageReadPaused = false;
  raceClient.release = () => {};
  raceClient.query = async (...args) => {
    const result = await raceQuery(...args);
    const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
    if (!pageReadPaused && sql?.includes("ORDER BY t.occurred_at, t.id COLLATE") && sql.includes("LIMIT")) {
      pageReadPaused = true;
      pageReadResolve();
      await pageReadReleased;
    }
    return result;
  };
  const raceStore = new PostgresObservationStore(async () => ({
    query: (...args) => raceClient.query(...args),
    connect: async () => raceClient,
  }), "timeline-race-test-secret");
  const raceObservation = normalizePodObservation(observationScope, {
    kind: "Pod",
    metadata: { name: "watermark-race", namespace: "tracegarden", uid: `watermark-race-${process.pid}`, resourceVersion: "1" },
    status: { phase: "Running" },
  }, "2099-12-31T00:00:00.000Z");
  try {
    const pagePromise = raceStore.listTimelineEntries("workspace-single", { limit: 1 }, sessionBody.member.id);
    await pageRead;
    const raceResult = await timelineStore.recordObservation(raceObservation);
    releasePageRead();
    const racePage = await pagePromise;
    assert.ok(racePage.resumeCursor);
    const resumedRacePage = await raceStore.listTimelineEntries("workspace-single", { limit: 100, cursor: racePage.resumeCursor }, sessionBody.member.id);
    assert.deepEqual(resumedRacePage.entries.map((entry) => entry.id), [raceResult.entry.id]);
  } finally {
    releasePageRead();
    await raceClient.end();
  }

  const scopeOrderingObservation = normalizePodObservation(observationScope, {
    kind: "Pod",
    metadata: { name: "scope-ordering", namespace: "tracegarden", uid: `scope-ordering-${process.pid}`, resourceVersion: "scope-ordering-1" },
    status: { phase: "Running" },
  }, "2099-11-02T00:00:00.000Z");
  const scopeOrderingCheckpoint = {
    workspaceId: observationScope.workspaceId,
    clusterId: observationScope.clusterId,
    namespace: "tracegarden",
    resourceKind: "Pod",
    resourceVersion: `scope-ordering-${process.pid}`,
  };
  const previousScopeOrderingCheckpoint = await timelineStore.getIngestionCheckpoint("workspace-single", observationScope.clusterId, "Pod", "tracegarden");
  const removedScope = { ...observationScope, namespaces: [], resourceKinds: [] };
  const scopeLockClient = new pg.Client(databaseUrl);
  const scopeProbeClient = new pg.Client(databaseUrl);
  let blockedScopePersistence;
  let pendingScopeRemoval;
  try {
    await scopeLockClient.connect();
    await scopeProbeClient.connect();
    await scopeLockClient.query("BEGIN");
    await scopeLockClient.query("SELECT id FROM tracegarden_clusters WHERE workspace_id = $1 FOR UPDATE", [observationScope.workspaceId]);
    blockedScopePersistence = timelineStore.recordObservationsAndCheckpoint([scopeOrderingObservation], scopeOrderingCheckpoint);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await scopeProbeClient.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%tracegarden_clusters%'",
      );
      if (Number(waiting.rows[0]?.count ?? 0) >= 1) break;
      if (attempt === 99) throw new Error("scope persistence did not wait for the authoritative Cluster row lock");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    pendingScopeRemoval = collectorDatabase.clusterScope.save(removedScope);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await scopeProbeClient.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%tracegarden_clusters%'",
      );
      if (Number(waiting.rows[0]?.count ?? 0) >= 2) break;
      if (attempt === 99) throw new Error("scope update did not wait behind in-flight scope validation");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await scopeLockClient.query("COMMIT");
    const [scopeOrderingResults, savedRemovedScope] = await Promise.all([blockedScopePersistence, pendingScopeRemoval]);
    assert.equal(scopeOrderingResults[0]?.duplicate, false);
    assert.deepEqual(savedRemovedScope.namespaces, []);
    assert.deepEqual(savedRemovedScope.resourceKinds, []);
    assert.equal((await collectorDatabase.clusterScope.get(observationScope.workspaceId))?.namespaces.length, 0);
    assert.equal((await timelineStore.getIngestionCheckpoint("workspace-single", observationScope.clusterId, "Pod", "tracegarden"))?.resourceVersion, scopeOrderingCheckpoint.resourceVersion);
    const failClosedObservation = normalizePodObservation(observationScope, {
      kind: "Pod",
      metadata: { name: "scope-fail-closed", namespace: "tracegarden", uid: `scope-fail-closed-${process.pid}`, resourceVersion: "scope-fail-closed-1" },
      status: { phase: "Running" },
    }, "2099-11-02T00:00:01.000Z");
    await assert.rejects(
      timelineStore.recordObservationsAndCheckpoint([failClosedObservation], {
        ...scopeOrderingCheckpoint,
        resourceVersion: `scope-fail-closed-${process.pid}`,
      }),
      /observation checkpoint persistence failed/,
    );
    assert.equal((await timelineStore.getIngestionCheckpoint("workspace-single", observationScope.clusterId, "Pod", "tracegarden"))?.resourceVersion, scopeOrderingCheckpoint.resourceVersion);
  } finally {
    await scopeLockClient.query("ROLLBACK").catch(() => undefined);
    await Promise.allSettled([blockedScopePersistence ?? Promise.resolve(), pendingScopeRemoval ?? Promise.resolve()]);
    const rejectedScopeSourceIdentity = `${observationScope.clusterId}:scope-fail-closed-${process.pid}`;
    const rejectedScopeCheckpointVersion = `scope-fail-closed-${process.pid}`;
    const rejectedObservationRows = await scopeProbeClient.query(
      "SELECT id FROM tracegarden_observations WHERE source_identity = $1",
      [rejectedScopeSourceIdentity],
    );
    assert.equal(rejectedObservationRows.rowCount, 0);
    const rejectedTimelineRows = await scopeProbeClient.query(
      `SELECT t.id
         FROM tracegarden_timeline_entries t
         JOIN tracegarden_observations o ON o.id = t.observation_id
        WHERE o.source_identity = $1`,
      [rejectedScopeSourceIdentity],
    );
    assert.equal(rejectedTimelineRows.rowCount, 0);
    const rejectedCheckpointRows = await scopeProbeClient.query(
      `SELECT resource_version
         FROM tracegarden_ingestion_checkpoints
        WHERE workspace_id = $1 AND cluster_id = $2 AND namespace = $3 AND resource_kind = $4 AND resource_version = $5`,
      [observationScope.workspaceId, observationScope.clusterId, "tracegarden", "Pod", rejectedScopeCheckpointVersion],
    );
    assert.equal(rejectedCheckpointRows.rowCount, 0);
    await collectorDatabase.clusterScope.save(observationScope);
    await timelineStore.clearIngestionCheckpoint(scopeOrderingCheckpoint).catch(() => undefined);
    if (previousScopeOrderingCheckpoint) {
      await timelineStore.recordObservationsAndCheckpoint([], {
        workspaceId: previousScopeOrderingCheckpoint.workspaceId,
        clusterId: previousScopeOrderingCheckpoint.clusterId,
        namespace: previousScopeOrderingCheckpoint.namespace,
        resourceKind: previousScopeOrderingCheckpoint.resourceKind,
        resourceVersion: previousScopeOrderingCheckpoint.resourceVersion,
      }).catch(() => undefined);
    }
    await scopeProbeClient.end().catch(() => undefined);
    await scopeLockClient.end().catch(() => undefined);
    const scopeOrderingCleanupClient = new pg.Client(databaseUrl);
    await scopeOrderingCleanupClient.connect();
    try {
      const cleanupSources = [scopeOrderingObservation.sourceIdentity, rejectedScopeSourceIdentity];
      await scopeOrderingCleanupClient.query("DELETE FROM tracegarden_observations WHERE source_identity = ANY($1::text[])", [cleanupSources]);
      const remaining = await scopeOrderingCleanupClient.query("SELECT count(*)::int AS count FROM tracegarden_observations WHERE source_identity = ANY($1::text[])", [cleanupSources]);
      assert.equal(Number(remaining.rows[0]?.count ?? 0), 0);
    } finally {
      await scopeOrderingCleanupClient.end();
    }
    assert.deepEqual((await collectorDatabase.clusterScope.get(observationScope.workspaceId))?.namespaces, observationScope.namespaces);
  }
  await unsubscribeTimeline();
  assert.equal(timelineStore.timelineListenerClient, null);
  const pendingObservation = normalizePodObservation(observationScope, {
    kind: "Pod",
    metadata: { name: "pending", namespace: "tracegarden", uid: "pod-uid-pending", resourceVersion: "10" },
    status: { phase: "Pending", conditions: [{ type: "Ready", status: "False", reason: "ContainersNotReady" }] },
  }, "2099-10-01T00:00:01.000Z");
  const firstHistory = await timelineStore.recordObservation(pendingObservation);
  assert.equal(firstHistory.entry.attention, true);
  const runningObservation = normalizePodObservation(observationScope, {
    kind: "Pod",
    metadata: { name: "running-later", namespace: "tracegarden", uid: "pod-uid-later", resourceVersion: "11" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }, "2099-10-01T00:00:02.000Z");
  await timelineStore.recordObservation(runningObservation);
  const correlationExperimentResponse = await fetch(`http://127.0.0.1:${webPort}/api/experiments`, {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ hypothesis: "review correlation", change: "inspect Pod", observation: "Pod remains pending", conclusion: "", state: "active", tags: [], workloads: [{ clusterId: "local-postgres-smoke", namespace: "tracegarden", kind: "Pod", name: "api" }] }),
  });
  assert.equal(correlationExperimentResponse.status, 201);
  const correlationExperiment = (await correlationExperimentResponse.json()).experiment;
  const correlationSuggestionsResponse = await fetch(`http://127.0.0.1:${webPort}/api/correlations/suggestions`, { headers: { cookie: ownerCookie } });
  assert.equal(correlationSuggestionsResponse.status, 200);
  const correlationSuggestions = (await correlationSuggestionsResponse.json()).suggestions;
  const correlationSuggestion = correlationSuggestions.find((candidate) => (candidate.leftEntryId === correlationExperiment.timelineEntryId || candidate.rightEntryId === correlationExperiment.timelineEntryId) && candidate.signals.includes("ownership"));
  assert.ok(correlationSuggestion);
  const confirmedCorrelationResponse = await fetch(`http://127.0.0.1:${webPort}/api/correlations/suggestions/${correlationSuggestion.id}/confirm`, { method: "POST", headers: { cookie: ownerCookie } });
  assert.equal(confirmedCorrelationResponse.status, 200);
  const confirmedCorrelation = await confirmedCorrelationResponse.json();
  assert.equal(confirmedCorrelation.confirmedLink.confirmedByMemberId, sessionBody.member.id);
  const repeatedConfirmation = await fetch(`http://127.0.0.1:${webPort}/api/correlations/suggestions/${correlationSuggestion.id}/confirm`, { method: "POST", headers: { cookie: ownerCookie } });
  assert.equal((await repeatedConfirmation.json()).idempotent, true);
  const concurrentExperimentResponse = await fetch(`http://127.0.0.1:${webPort}/api/experiments`, {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ hypothesis: "concurrent review", change: "inspect Pod", observation: "pending", conclusion: "", state: "active", tags: [], workloads: [{ clusterId: "local-postgres-smoke", namespace: "tracegarden", kind: "Pod", name: "api" }] }),
  });
  const concurrentExperiment = (await concurrentExperimentResponse.json()).experiment;
  const concurrentSuggestions = (await (await fetch(`http://127.0.0.1:${webPort}/api/correlations/suggestions`, { headers: { cookie: ownerCookie } })).json()).suggestions;
  const concurrentSuggestion = concurrentSuggestions.find((candidate) => (candidate.leftEntryId === concurrentExperiment.timelineEntryId || candidate.rightEntryId === concurrentExperiment.timelineEntryId) && candidate.signals.includes("ownership"));
  assert.ok(concurrentSuggestion);
  const concurrentResponses = await Promise.all([1, 2].map(() => fetch(`http://127.0.0.1:${webPort}/api/correlations/suggestions/${concurrentSuggestion.id}/confirm`, { method: "POST", headers: { cookie: ownerCookie } })));
  assert.deepEqual((await Promise.all(concurrentResponses.map(async (response) => (await response.json()).idempotent))).sort(), [false, true]);
  const concurrentLinks = await collectorDatabase.timeline.listConfirmedLinks("workspace-single", concurrentExperiment.timelineEntryId);
  assert.equal(concurrentLinks.filter((link) => link.suggestionId === concurrentSuggestion.id).length, 1);
  const linkedCorrelationTimeline = await fetch(`http://127.0.0.1:${webPort}/api/timeline?limit=100`, { headers: { cookie: ownerCookie } });
  const linkedTimelineEntries = (await linkedCorrelationTimeline.json()).entries;
  assert.ok(linkedTimelineEntries.find((entry) => entry.id === correlationExperiment.timelineEntryId)?.confirmedLinks?.length);
  const linkedCorrelationExperiment = await fetch(`http://127.0.0.1:${webPort}/api/experiments/${correlationExperiment.id}`, { headers: { cookie: ownerCookie } });
  assert.ok((await linkedCorrelationExperiment.json()).experiment.confirmedLinks.length >= 1);
  const secondCorrelationExperimentResponse = await fetch(`http://127.0.0.1:${webPort}/api/experiments`, {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ hypothesis: "reject correlation", change: "inspect Pod", observation: "not a review", conclusion: "", state: "active", tags: [], workloads: [{ clusterId: "local-postgres-smoke", namespace: "tracegarden", kind: "Pod", name: "api" }] }),
  });
  const secondCorrelationExperiment = (await secondCorrelationExperimentResponse.json()).experiment;
  const postConfirmSuggestions = (await (await fetch(`http://127.0.0.1:${webPort}/api/correlations/suggestions`, { headers: { cookie: ownerCookie } })).json()).suggestions;
  const rejectedCorrelationSuggestion = postConfirmSuggestions.find((candidate) => candidate.leftEntryId === secondCorrelationExperiment.timelineEntryId || candidate.rightEntryId === secondCorrelationExperiment.timelineEntryId);
  assert.ok(rejectedCorrelationSuggestion);
  const rejectedCorrelationResponse = await fetch(`http://127.0.0.1:${webPort}/api/correlations/suggestions/${rejectedCorrelationSuggestion.id}/reject`, { method: "POST", headers: { cookie: ownerCookie } });
  assert.equal(rejectedCorrelationResponse.status, 200);
  const remainingSuggestions = (await (await fetch(`http://127.0.0.1:${webPort}/api/correlations/suggestions`, { headers: { cookie: ownerCookie } })).json()).suggestions;
  assert.equal(remainingSuggestions.some((candidate) => candidate.id === rejectedCorrelationSuggestion.id), false);

  const viewerRoleResponse = await fetch(`http://127.0.0.1:${webPort}/api/members/${invitedSessionBody.member.id}/role`, {
    method: "PATCH",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ role: "viewer" }),
  });
  assert.equal(viewerRoleResponse.status, 200);
  const viewerDecision = await fetch(`http://127.0.0.1:${webPort}/api/correlations/suggestions/${correlationSuggestion.id}/confirm`, { method: "POST", headers: { cookie: invitedLogin.headers.get("set-cookie") ?? "" } });
  assert.equal(viewerDecision.status, 403);
  const historyPageOne = await timelineStore.listTimelineEntries("workspace-single", { limit: 1 }, sessionBody.member.id);
  assert.equal(historyPageOne.entries.length, 1);
  assert.ok(historyPageOne.nextCursor);
  const historyPageTwo = await timelineStore.listTimelineEntries("workspace-single", { limit: 1, cursor: historyPageOne.nextCursor }, sessionBody.member.id);
  assert.equal(historyPageTwo.entries.length, 1);
  assert.notEqual(historyPageTwo.entries[0].id, historyPageOne.entries[0].id);
  const historyCursor = historyPageOne.nextCursor;
  assert.ok(historyCursor);
  if (historyCursor) {
    const [encodedPayload, encodedSignature] = historyCursor.split(".");
    const historyCursorPayload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    assert.equal(historyCursorPayload.version, 3);
    assert.equal(historyCursorPayload.occurredAt, historyPageOne.entries[0].occurredAt);
    assert.equal(historyCursorPayload.entryId, historyPageOne.entries[0].id);
    assert.ok(encodedPayload && encodedSignature);
    const alteredPayload = `${encodedPayload.slice(0, -1)}${encodedPayload.endsWith("A") ? "B" : "A"}`;
    await assert.rejects(
      timelineStore.listTimelineEntries("workspace-single", { limit: 1, cursor: `${alteredPayload}.${encodedSignature}` }, sessionBody.member.id),
      (error) => error instanceof TimelineQueryValidationError,
    );
    const alteredSignature = `${encodedSignature.slice(0, -1)}${encodedSignature.endsWith("A") ? "B" : "A"}`;
    await assert.rejects(
      timelineStore.listTimelineEntries("workspace-single", { limit: 1, cursor: `${encodedPayload}.${alteredSignature}` }, sessionBody.member.id),
      (error) => error instanceof TimelineQueryValidationError,
    );
    await assert.rejects(
      timelineStore.listTimelineEntries("workspace-single", { limit: 1, cursor: historyCursor, namespace: "different-namespace" }, sessionBody.member.id),
      (error) => error instanceof TimelineQueryValidationError,
    );
    await assert.rejects(
      timelineStore.listTimelineEntries("workspace-single", { limit: 1, cursor: historyCursor }, invitedSessionBody.member.id),
      (error) => error instanceof TimelineQueryValidationError,
    );
  }
  const insertedAfterBoundary = normalizePodObservation(observationScope, {
    kind: "Pod",
    metadata: { name: "inserted-newer", namespace: "tracegarden", uid: "pod-uid-newer", resourceVersion: "12" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }, "2099-10-01T00:00:03.000Z");
  await timelineStore.recordObservation(insertedAfterBoundary);
  const tieTimestamp = "2099-10-01T00:00:04.000Z";
  const equalTimestampA = normalizePodObservation(observationScope, {
    kind: "Pod",
    metadata: { name: "equal-a", namespace: "tracegarden", uid: "pod-uid-equal-a", resourceVersion: "13" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }, tieTimestamp);
  const equalTimestampB = normalizePodObservation(observationScope, {
    kind: "Pod",
    metadata: { name: "equal-b", namespace: "tracegarden", uid: "pod-uid-equal-b", resourceVersion: "14" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }, tieTimestamp);
  const equalResultA = await timelineStore.recordObservation(equalTimestampA);
  const equalResultB = await timelineStore.recordObservation(equalTimestampB);
  const expectedEqualOrder = equalResultA.entry.id < equalResultB.entry.id ? ["equal-a", "equal-b"] : ["equal-b", "equal-a"];
  const traversedIds = [];
  const traversedNames = [];
  const traversedTimes = [];
  let traversal = await timelineStore.listTimelineEntries("workspace-single", { limit: 1, namespace: "tracegarden" }, sessionBody.member.id);
  while (true) {
    const entry = traversal.entries[0];
    if (!entry) break;
    traversedIds.push(entry.id);
    traversedNames.push(entry.observation.name);
    traversedTimes.push(entry.occurredAt);
    if (!traversal.nextCursor) break;
    traversal = await timelineStore.listTimelineEntries("workspace-single", { limit: 1, namespace: "tracegarden", cursor: traversal.nextCursor }, sessionBody.member.id);
  }
  assert.equal(new Set(traversedIds).size, traversedIds.length);
  assert.deepEqual(new Set(traversedNames), new Set(["api", "api-deployment", "live-entry", "missed-live-entry", "pending", "running-later", "inserted-newer", "reconnected-live-entry", "concurrency-before", "concurrency-after", "equal-a", "equal-b", "watermark-race"]));
  const equalIndexes = [traversedNames.indexOf("equal-a"), traversedNames.indexOf("equal-b")].sort((left, right) => left - right);
  assert.equal(equalIndexes[1] - equalIndexes[0], 1);
  assert.deepEqual(traversedNames.slice(equalIndexes[0], equalIndexes[1] + 1), expectedEqualOrder);
  assert.equal(traversedTimes[equalIndexes[0]], tieTimestamp);
  assert.equal(traversedTimes[equalIndexes[1]], tieTimestamp);
  const memberlessHistory = await timelineStore.listTimelineEntries("workspace-single", { limit: 10 });
  assert.ok(memberlessHistory.entries.some(({ attention }) => attention));
  assert.ok(memberlessHistory.entries.every(({ attentionUnread }) => !attentionUnread));
  const historyPageTwoAgain = await timelineStore.listTimelineEntries("workspace-single", { limit: 1, cursor: historyPageOne.nextCursor }, sessionBody.member.id);
  assert.equal(historyPageTwoAgain.entries[0].id, historyPageTwo.entries[0].id);
  const attentionHistory = await timelineStore.listTimelineEntries("workspace-single", { limit: 10, attention: true, unread: true }, sessionBody.member.id);
  assert.deepEqual(attentionHistory.entries.map(({ observation }) => observation.name), ["api-deployment", "pending"]);
  assert.equal(attentionHistory.unreadAttentionCount, 2);
  const reviewedAttentionBeforeReview = await timelineStore.listTimelineEntries("workspace-single", { limit: 10, attention: true, unread: false }, sessionBody.member.id);
  assert.deepEqual(reviewedAttentionBeforeReview.entries, []);
  const reviewedAttention = await timelineStore.reviewAttentionItem("workspace-single", sessionBody.member.id, firstHistory.entry.id);
  assert.deepEqual(reviewedAttention, { entryId: firstHistory.entry.id, reviewed: true, unreadCount: 1 });
  const reviewedAgain = await timelineStore.reviewAttentionItem("workspace-single", sessionBody.member.id, firstHistory.entry.id);
  assert.deepEqual(reviewedAgain, { entryId: firstHistory.entry.id, reviewed: false, unreadCount: 1 });
  assert.equal((await timelineStore.unreadAttentionCount("workspace-single", invitedSessionBody.member.id)), 2);
  const reviewedAttentionAfterReview = await timelineStore.listTimelineEntries("workspace-single", { limit: 10, attention: true, unread: false }, sessionBody.member.id);
  assert.deepEqual(reviewedAttentionAfterReview.entries.map(({ observation }) => observation.name), ["pending"]);
  const attentionApi = await fetch(`http://127.0.0.1:${webPort}/api/timeline?limit=10&attention=true&unread=true`, { headers: { cookie: ownerCookie } });
  assert.equal(attentionApi.status, 200);
  assert.equal((await attentionApi.json()).unreadAttentionCount, 1);
  const reviewedAttentionApi = await fetch(`http://127.0.0.1:${webPort}/api/timeline?limit=10&attention=true&unread=false`, { headers: { cookie: ownerCookie } });
  assert.equal(reviewedAttentionApi.status, 200);
  assert.deepEqual((await reviewedAttentionApi.json()).entries.map(({ observation }) => observation.name), ["pending"]);
  const reviewApi = await fetch(`http://127.0.0.1:${webPort}/api/timeline/entries/${encodeURIComponent(firstHistory.entry.id)}/review`, {
    method: "POST",
    headers: { cookie: ownerCookie },
  });
  assert.equal(reviewApi.status, 200);
  assert.deepEqual(await reviewApi.json(), { entryId: firstHistory.entry.id, reviewed: false, unreadCount: 1 });
  const invalidReviewApi = await fetch(`http://127.0.0.1:${webPort}/api/timeline/entries/not%20an%20id/review`, {
    method: "POST",
    headers: { cookie: ownerCookie },
  });
  assert.equal(invalidReviewApi.status, 400);
  const invalidTimelineFilter = await fetch(`http://127.0.0.1:${webPort}/api/timeline?attention=maybe`, { headers: { cookie: ownerCookie } });
  assert.equal(invalidTimelineFilter.status, 400);
  const internalFlashApi = await fetch(`http://127.0.0.1:${webPort}/api/timeline?attention=reviewed`, { headers: { cookie: ownerCookie } });
  assert.equal(internalFlashApi.status, 400);
  const rejected = await fetch(`http://127.0.0.1:${webPort}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "identity=rejected&lang=en",
  });
  assert.equal(rejected.status, 403);
  assert.match(await rejected.text(), /no valid Workspace admission/);
  const raceInvitationResponse = await fetch(`http://127.0.0.1:${webPort}/api/invitations`, {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "rejected@example.test" }),
  });
  const raceInvitation = (await raceInvitationResponse.json()).invitation;
  const [raceAdmission, raceRevocation] = await Promise.all([
    fetch(`http://127.0.0.1:${webPort}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "identity=rejected&lang=en",
    }),
    fetch(`http://127.0.0.1:${webPort}/api/invitations/${raceInvitation.id}/revoke`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    }),
  ]);
  assert.ok(raceAdmission.status === 303 || raceAdmission.status === 403);
  assert.equal(raceAdmission.status === 303, raceRevocation.status === 404);
  const listedInvitations = await fetch(`http://127.0.0.1:${webPort}/api/invitations`, { headers: { cookie: ownerCookie } });
  const listedRaceInvitation = (await listedInvitations.json()).invitations.find(({ id }) => id === raceInvitation.id);
  assert.equal(listedRaceInvitation.acceptedAt !== null, raceAdmission.status === 303);
  assert.equal(listedRaceInvitation.revokedAt !== null, raceRevocation.status === 200);
  const memberCount = docker("exec", name, "psql", "-At", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT count(*) FROM tracegarden_members;");
  assert.equal(memberCount, raceAdmission.status === 303 ? "3" : "2");
  const auditCount = docker("exec", name, "psql", "-At", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT count(*) FROM tracegarden_audit_records;");
  assert.equal(auditCount, "11");
  const auditMetadata = docker("exec", name, "psql", "-At", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT coalesce(string_agg(metadata::text, ' '), '') FROM tracegarden_audit_records;");
  assert.doesNotMatch(auditMetadata, /token/i);
  let auditMutationRejected = false;
  try {
    docker("exec", name, "psql", "-At", "-U", "tracegarden", "-d", "tracegarden", "-c", "UPDATE tracegarden_audit_records SET metadata = metadata;");
  } catch {
    auditMutationRejected = true;
  }
  assert.equal(auditMutationRejected, true);
  let auditTruncateRejected = false;
  try {
    docker("exec", name, "psql", "-At", "-U", "tracegarden", "-d", "tracegarden", "-c", "TRUNCATE tracegarden_audit_records;");
  } catch {
    auditTruncateRejected = true;
  }
  assert.equal(auditTruncateRejected, true);
  const rollbackNotificationClient = new pg.Client(databaseUrl);
  const rollbackTransactionClient = new pg.Client(databaseUrl);
  await rollbackNotificationClient.connect();
  await rollbackTransactionClient.connect();
  try {
    await rollbackNotificationClient.query("LISTEN tracegarden_timeline");
    const receivedNotifications = [];
    const committedPayload = JSON.stringify({ entryId: "committed-after-rollback" });
    const committedNotification = new Promise((resolve) => rollbackNotificationClient.on("notification", (message) => {
      receivedNotifications.push(message.payload);
      if (message.payload === committedPayload) resolve();
    }));
    await rollbackTransactionClient.query("BEGIN");
    await rollbackTransactionClient.query("SELECT pg_notify('tracegarden_timeline', $1)", [JSON.stringify({ entryId: "rolled-back-after-notify" })]);
    await rollbackTransactionClient.query("ROLLBACK");
    await rollbackTransactionClient.query("BEGIN");
    await rollbackTransactionClient.query("SELECT pg_notify('tracegarden_timeline', $1)", [committedPayload]);
    await rollbackTransactionClient.query("COMMIT");
    await committedNotification;
    assert.deepEqual(receivedNotifications, [committedPayload]);
  } finally {
    await rollbackTransactionClient.end();
    await rollbackNotificationClient.end();
  }

  const refreshFailureObservation = normalizePodObservation(observationScope, {
    kind: "Pod",
    metadata: { name: "refresh-failure", namespace: "tracegarden", uid: "pod-uid-refresh-failure", resourceVersion: "refresh-failure-1" },
    status: { phase: "Running" },
  }, "2099-12-01T00:00:00.000Z");
  const originalRefreshCorrelationSuggestions = timelineStore.refreshCorrelationSuggestions;
  const originalConsoleError = console.error;
  const refreshErrors = [];
  console.error = (...args) => refreshErrors.push(args.join(" "));
  timelineStore.refreshCorrelationSuggestions = async () => {
    throw new Error("refresh failure payload must not be logged");
  };
  let refreshFailureEntryId;
  try {
    const refreshFailureResult = await timelineStore.recordObservationsAndCheckpoint([refreshFailureObservation], {
      workspaceId: observationScope.workspaceId,
      clusterId: observationScope.clusterId,
      namespace: "tracegarden",
      resourceKind: "Pod",
      resourceVersion: "refresh-failure-1",
    });
    assert.equal(refreshFailureResult[0]?.duplicate, false);
    refreshFailureEntryId = refreshFailureResult[0]?.entry.id;
  } finally {
    timelineStore.refreshCorrelationSuggestions = originalRefreshCorrelationSuggestions;
    console.error = originalConsoleError;
  }
  assert.deepEqual(refreshErrors, ["Tracegarden correlation refresh failed after durable persistence"]);
  assert.doesNotMatch(refreshErrors.join(" "), /refresh-failure|payload/);
  assert.equal((await timelineStore.getIngestionCheckpoint("workspace-single", observationScope.clusterId, "Pod", "tracegarden"))?.resourceVersion, "refresh-failure-1");
  assert.ok(refreshFailureEntryId);
  assert.ok(await timelineStore.getTimelineEntry("workspace-single", refreshFailureEntryId));

  const concurrentNamespaces = ["concurrent-alpha", "concurrent-beta", "concurrent-gamma", "concurrent-delta", "concurrent-epsilon"];
  await collectorDatabase.clusterScope.save({ ...observationScope, namespaces: concurrentNamespaces });
  try {
    const concurrentWrites = Promise.all(concurrentNamespaces.map((namespace, index) => {
      const observation = normalizePodObservation({ ...observationScope, namespaces: [namespace] }, {
        kind: "Pod",
        metadata: { name: `concurrent-${index}`, namespace, uid: `pod-uid-concurrent-${index}`, resourceVersion: "1" },
        status: { phase: "Running" },
      }, "2099-12-02T00:00:00.000Z");
      return timelineStore.recordObservationsAndCheckpoint([observation], {
        workspaceId: observationScope.workspaceId,
        clusterId: observationScope.clusterId,
        namespace,
        resourceKind: "Pod",
        resourceVersion: "1",
      });
    }));
    let concurrentTimeout;
    const concurrentResults = await Promise.race([
      concurrentWrites,
      new Promise((_, reject) => {
        concurrentTimeout = setTimeout(() => reject(new Error("concurrent namespace writes timed out")), 5000);
      }),
    ]);
    clearTimeout(concurrentTimeout);
    assert.equal(concurrentResults.length, concurrentNamespaces.length);
    const concurrentCheckpoints = await Promise.all(concurrentNamespaces.map((namespace) => timelineStore.getIngestionCheckpoint("workspace-single", observationScope.clusterId, "Pod", namespace)));
    assert.ok(concurrentCheckpoints.every((checkpoint) => checkpoint?.resourceVersion === "1"));
  } finally {
    await collectorDatabase.clusterScope.save(observationScope);
  }

  const originalExperimentRefreshCorrelationSuggestions = timelineStore.refreshCorrelationSuggestions;
  const originalExperimentConsoleError = console.error;
  const experimentRefreshErrors = [];
  console.error = (...args) => experimentRefreshErrors.push(args.join(" "));
  timelineStore.refreshCorrelationSuggestions = async () => {
    throw new Error("experiment refresh payload must not be logged");
  };
  let refreshFailureExperiment;
  let refreshFailureUpdatedExperiment;
  try {
    refreshFailureExperiment = await timelineStore.createExperiment("workspace-single", sessionBody.member.id, {
      hypothesis: "deterministic refresh failure",
      change: "test create persistence",
      observation: "durable create",
      conclusion: "",
      state: "active",
      tags: [],
      workloads: [],
      gitRevision: null,
    });
    refreshFailureUpdatedExperiment = await timelineStore.updateExperiment("workspace-single", refreshFailureExperiment.id, {
      conclusion: "durable update",
      state: "concluded",
      tags: ["refresh-failure"],
    });
  } finally {
    timelineStore.refreshCorrelationSuggestions = originalExperimentRefreshCorrelationSuggestions;
    console.error = originalExperimentConsoleError;
  }
  assert.equal(refreshFailureExperiment.state, "active");
  assert.equal(refreshFailureUpdatedExperiment?.state, "concluded");
  assert.deepEqual(experimentRefreshErrors, [
    "Tracegarden correlation refresh failed after durable persistence",
    "Tracegarden correlation refresh failed after durable persistence",
  ]);
  assert.doesNotMatch(experimentRefreshErrors.join(" "), /deterministic|payload/);

  const postCommitPool = collectorDatabase.pool;
  assert.ok(postCommitPool);
  const originalPostCommitPoolQuery = postCommitPool.query;
  let postCommitPoolQueries = 0;
  postCommitPool.query = async () => {
    postCommitPoolQueries += 1;
    throw new Error("post-commit readback payload must not be requested");
  };
  let noReadbackExperiment;
  let noReadbackUpdatedExperiment;
  try {
    noReadbackExperiment = await timelineStore.createExperiment("workspace-single", sessionBody.member.id, {
      hypothesis: "post-commit readback failure",
      change: "test durable create",
      observation: "no readback",
      conclusion: "",
      state: "active",
      tags: [],
      workloads: [],
      gitRevision: null,
    });
    noReadbackUpdatedExperiment = await timelineStore.updateExperiment("workspace-single", noReadbackExperiment.id, {
      conclusion: "no readback update",
      state: "concluded",
      tags: ["post-commit-readback"],
    });
  } finally {
    postCommitPool.query = originalPostCommitPoolQuery;
  }
  assert.equal(postCommitPoolQueries, 0);
  assert.equal(noReadbackExperiment.state, "active");
  assert.equal(noReadbackUpdatedExperiment?.state, "concluded");
  assert.equal((await timelineStore.getExperiment("workspace-single", noReadbackExperiment.id))?.state, "concluded");

  let retentionGetterQueries = 0;
  const retentionGetterFailurePool = {
    query: async () => {
      retentionGetterQueries += 1;
      if (retentionGetterQueries === 2) throw new Error("injected retention readback failure");
      return { rows: [{ workspace_id: "workspace-single", retention_days: 90, updated_at: "2026-01-01T00:00:00.000Z" }], rowCount: 1 };
    },
  };
  const retentionGetterFailureStore = new PostgresObservationStore(async () => retentionGetterFailurePool);
  const injectedFailurePolicy = await retentionGetterFailureStore.getRetentionPolicy("workspace-single");
  assert.equal(injectedFailurePolicy.retentionDays, 90);
  assert.equal(retentionGetterQueries, 1);

  const retentionConcurrencyClient = new pg.Client(databaseUrl);
  await retentionConcurrencyClient.connect();
  try {
    await retentionConcurrencyClient.query("DELETE FROM tracegarden_retention_policies WHERE workspace_id = 'workspace-single'");
  } finally {
    await retentionConcurrencyClient.end();
  }
  const concurrentRetentionPolicies = await Promise.all(Array.from({ length: 5 }, () => timelineStore.getRetentionPolicy("workspace-single")));
  assert.deepEqual(concurrentRetentionPolicies.map((policy) => policy.retentionDays), [90, 90, 90, 90, 90]);
  const retentionCountClient = new pg.Client(databaseUrl);
  await retentionCountClient.connect();
  try {
    const retentionCount = await retentionCountClient.query("SELECT count(*)::text AS count FROM tracegarden_retention_policies WHERE workspace_id = 'workspace-single'");
    assert.equal(retentionCount.rows[0]?.count, "1");
  } finally {
    await retentionCountClient.end();
  }

  const concurrentExperimentCreates = Promise.all(Array.from({ length: 5 }, (_, index) => timelineStore.createExperiment("workspace-single", sessionBody.member.id, {
    hypothesis: `concurrent create ${index}`,
    change: "pool-size-five create",
    observation: "durable create",
    conclusion: "",
    state: "active",
    tags: [],
    workloads: [],
    gitRevision: null,
  })));
  let concurrentExperimentCreateTimeout;
  const concurrentCreatedExperiments = await Promise.race([
    concurrentExperimentCreates,
    new Promise((_, reject) => {
      concurrentExperimentCreateTimeout = setTimeout(() => reject(new Error("concurrent experiment creates timed out")), 5000);
    }),
  ]);
  clearTimeout(concurrentExperimentCreateTimeout);
  assert.equal(concurrentCreatedExperiments.length, 5);

  const concurrentExperimentUpdates = Promise.all(concurrentCreatedExperiments.map((createdExperiment, index) => timelineStore.updateExperiment("workspace-single", createdExperiment.id, {
    conclusion: `concurrent update ${index}`,
    state: "concluded",
    tags: ["pool-size-five"],
  })));
  let concurrentExperimentUpdateTimeout;
  const concurrentUpdatedExperiments = await Promise.race([
    concurrentExperimentUpdates,
    new Promise((_, reject) => {
      concurrentExperimentUpdateTimeout = setTimeout(() => reject(new Error("concurrent experiment updates timed out")), 5000);
    }),
  ]);
  clearTimeout(concurrentExperimentUpdateTimeout);
  assert.equal(concurrentUpdatedExperiments.length, 5);
  assert.ok(concurrentUpdatedExperiments.every((experiment) => experiment?.state === "concluded"));

  const parityObservations = await Promise.all(["a", "b", "c"].map((suffix, index) => timelineStore.recordObservation(normalizePodObservation(observationScope, {
    kind: "Pod",
    metadata: { name: "parity-api", namespace: "tracegarden", uid: `pod-uid-parity-${suffix}`, resourceVersion: `parity-${index + 1}` },
    status: { phase: "Running" },
  }, `2099-09-02T00:00:0${index}.000Z`))));
  const parityExperiment = await timelineStore.createExperiment("workspace-single", sessionBody.member.id, {
    hypothesis: "correlation reconciliation parity",
    change: "inspect Pod",
    observation: "preserve decided evidence",
    conclusion: "",
    state: "active",
    tags: [],
    workloads: [{ clusterId: observationScope.clusterId, namespace: "tracegarden", kind: "Pod", name: "parity-api" }],
  });
  const parityCandidateFor = async (entryId) => (await timelineStore.listCorrelationSuggestions("workspace-single"))
    .find((candidate) => (candidate.leftEntryId === parityExperiment.timelineEntryId || candidate.rightEntryId === parityExperiment.timelineEntryId)
      && (candidate.leftEntryId === entryId || candidate.rightEntryId === entryId));
  const parityCandidates = await Promise.all(parityObservations.map(({ entry }) => parityCandidateFor(entry.id)));
  assert.ok(parityCandidates.every((candidate) => candidate));
  const parityConfirmedResult = await timelineStore.decideCorrelationSuggestion("workspace-single", parityCandidates[0].id, sessionBody.member.id, "confirm");
  const parityRejectedResult = await timelineStore.decideCorrelationSuggestion("workspace-single", parityCandidates[1].id, sessionBody.member.id, "reject");
  assert.equal(parityConfirmedResult?.suggestion.status, "confirmed");
  assert.equal(parityRejectedResult?.suggestion.status, "rejected");
  const confirmedParityEvidence = await timelineStore.getCorrelationSuggestion("workspace-single", parityCandidates[0].id);
  const rejectedParityEvidence = await timelineStore.getCorrelationSuggestion("workspace-single", parityCandidates[1].id);
  await timelineStore.updateExperiment("workspace-single", parityExperiment.id, {
    workloads: [{ clusterId: observationScope.clusterId, namespace: "tracegarden", kind: "Deployment", name: "unrelated-parity" }],
  });
  assert.equal((await timelineStore.listCorrelationSuggestions("workspace-single")).some((candidate) => candidate.id === parityCandidates[2].id), false);
  assert.deepEqual(await timelineStore.getCorrelationSuggestion("workspace-single", parityCandidates[0].id), confirmedParityEvidence);
  assert.deepEqual(await timelineStore.getCorrelationSuggestion("workspace-single", parityCandidates[1].id), rejectedParityEvidence);

  productionWeb = spawn("bun", ["dist/apps/web/src/bun.js"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: "local-test-secret",
      TIMELINE_CURSOR_SECRET: "local-test-timeline-cursor-secret",
      BETTER_AUTH_URL: "https://tracegarden.test",
      GOOGLE_CLIENT_ID: "local-test-client",
      GOOGLE_CLIENT_SECRET: "local-test-secret",
      GOOGLE_REDIRECT_URI: "https://tracegarden.test/api/auth/callback/google",
      TRACEGARDEN_BOOTSTRAP_ISSUER: "https://accounts.google.com",
      TRACEGARDEN_BOOTSTRAP_SUBJECT: "local-test-bootstrap",
      PORT: String(productionWebPort),
      HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let productionOutput = "";
  productionWeb.stdout.on("data", (chunk) => { productionOutput += chunk; });
  productionWeb.stderr.on("data", (chunk) => { productionOutput += chunk; });
  let productionReadiness;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      productionReadiness = await fetch(`http://127.0.0.1:${productionWebPort}/health/readiness`);
      break;
    } catch {
      if (attempt === 39) throw new Error(`production web did not become ready: ${productionOutput}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(productionReadiness);
  assert.equal(productionReadiness.status, 200);
  const productionLogin = await fetch(`http://127.0.0.1:${productionWebPort}/?lang=en`, { redirect: "manual" });
  assert.equal(productionLogin.status, 200);
  assert.match(await productionLogin.text(), /Sign in with Google/);
  const googleRedirect = await fetch(`http://127.0.0.1:${productionWebPort}/auth/google`, { redirect: "manual" });
  assert.equal(googleRedirect.status, 302);
  const googleLocation = googleRedirect.headers.get("location") ?? "";
  assert.match(googleLocation, /client_id=local-test-client/);
  assert.match(googleLocation, /redirect_uri=https%3A%2F%2Ftracegarden.test%2Fapi%2Fauth%2Fcallback%2Fgoogle/);
  assert.doesNotMatch(googleLocation, /local-test-secret/);
  console.log("PostgreSQL migration, admission, Experiment, normalized Observation, live Timeline, rollback, and Better Auth integration smoke passed");
} finally {
  await collector?.close();
  collectorProcess?.kill("SIGTERM");
  await collectorDatabase?.close();
  await legacyMigrationDatabase?.close();
  web?.kill("SIGTERM");
  productionWeb?.kill("SIGTERM");
  await logDatabase?.close();
  removeDatabase();
}
