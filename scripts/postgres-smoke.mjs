import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createCollectorRuntime } from "../dist/apps/collector/src/main.js";
import { DeterministicKubernetesAdapter, normalizeObservation } from "../dist/packages/cluster/src/index.js";
import { PostgresDatabase } from "../dist/packages/db/src/index.js";
import { FakeKubernetesLogAdapter, requestRecentLogWindow } from "../dist/packages/logs/src/index.js";

const name = `tracegarden-foundation-pg-${process.pid}`;
const databasePort = 45433;
const webPort = 43200;
const productionWebPort = 43201;
let web;
let productionWeb;
let logDatabase;
const databaseUrl = `postgresql://tracegarden:local-only@127.0.0.1:${databasePort}/tracegarden`;
let collector;
let collectorDatabase;
let collectorProcess;

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function removeDatabase() {
  try { docker("rm", "-f", name); } catch { /* already absent */ }
}

removeDatabase();
try {
  docker("run", "-d", "--name", name, "-p", `${databasePort}:5432`, "-e", "POSTGRES_DB=tracegarden", "-e", "POSTGRES_USER=tracegarden", "-e", "POSTGRES_PASSWORD=local-only", "postgres:18.3-alpine");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      docker("exec", name, "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT 1");
      break;
    } catch {
      if (attempt === 39) throw new Error("PostgreSQL did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  web = spawn(process.execPath, ["dist/apps/web/src/main.js"], {
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
  const migrationCount = docker("exec", name, "psql", "-At", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT count(*) FROM tracegarden_schema_migrations WHERE id IN ('0001_foundation', '0002_workspace_admission', '0003_better_auth', '0004_membership_management', '0005_cluster_scope', '0006_observation_timeline', '0007_recent_logs', '0008_normalized_observations', '0009_observation_checkpoints');");
  assert.equal(migrationCount, "9");
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
  assert.equal(collectorReadiness.status, 200);
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
  assert.equal(await collectorDatabase.timeline.countTimelineEntries("workspace-single"), 1);
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
  assert.equal(await collectorDatabase.timeline.countTimelineEntries("workspace-single"), 4);
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
  assert.equal((await collectorDatabase.timeline.getIngestionCheckpoint("workspace-single", "local-postgres-smoke", "Pod", "tracegarden"))?.resourceVersion, "7");
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
  assert.equal(timelineBody.entries.length, 4);
  assert.ok(timelineBody.entries.some(({ observation }) => observation.name === "api"));
  assert.ok(timelineBody.entries.some(({ observation }) => observation.name === "api-deployment" && observation.classification === "recovery"));
  const timelinePage = await fetch(`http://127.0.0.1:${webPort}/app?lang=en`, { headers: { cookie: ownerCookie } });
  assert.match(await timelinePage.text(), /Pod Observation/);
  const timelinePageChinese = await fetch(`http://127.0.0.1:${webPort}/app?lang=zh-CN`, { headers: { cookie: ownerCookie } });
  assert.match(await timelinePageChinese.text(), /已提交的 Kubernetes Observation 会出现在这里/);
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
  assert.equal(auditCount, "9");
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

  productionWeb = spawn(process.execPath, ["dist/apps/web/src/main.js"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: "local-test-secret",
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
  console.log("PostgreSQL migration, admission, normalized Observation, Timeline, rollback, and Better Auth integration smoke passed");
} finally {
  await collector?.close();
  collectorProcess?.kill("SIGTERM");
  await collectorDatabase?.close();
  web?.kill("SIGTERM");
  productionWeb?.kill("SIGTERM");
  await logDatabase?.close();
  removeDatabase();
}
