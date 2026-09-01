import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createCollectorRuntime } from "../dist/apps/collector/src/main.js";
import { DeterministicKubernetesAdapter, normalizeObservation, normalizePodObservation } from "../dist/packages/cluster/src/index.js";
import { PostgresDatabase, TimelineQueryValidationError } from "../dist/packages/db/src/index.js";
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
  const migrationCount = docker("exec", name, "psql", "-At", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT count(*) FROM tracegarden_schema_migrations WHERE id IN ('0001_foundation', '0002_workspace_admission', '0003_better_auth', '0004_membership_management', '0005_cluster_scope', '0006_observation_timeline', '0007_recent_logs', '0008_normalized_observations', '0009_observation_checkpoints', '0010_timeline_attention', '0011_structured_experiments');");
  assert.equal(migrationCount, "11");
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
  assert.equal(timelineBody.entries.length, 5);
  assert.ok(timelineBody.entries.some(({ observation }) => observation.name === "api"));
  assert.ok(timelineBody.entries.some(({ observation }) => observation.name === "api-deployment" && observation.classification === "recovery"));
  assert.ok(timelineBody.entries.some((entry) => entry.entryType === "experiment" && entry.experiment.id === experiment.id));
  const timelinePage = await fetch(`http://127.0.0.1:${webPort}/app?lang=en`, { headers: { cookie: ownerCookie } });
  assert.match(await timelinePage.text(), /Pod Observation/);
  const timelinePageChinese = await fetch(`http://127.0.0.1:${webPort}/app?lang=zh-CN`, { headers: { cookie: ownerCookie } });
  assert.match(await timelinePageChinese.text(), /已提交的 Kubernetes Observation 会出现在这里/);
  const timelineStore = collectorDatabase.timeline;
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
  const expectedEqualOrder = equalResultA.entry.id.localeCompare(equalResultB.entry.id) < 0 ? ["equal-a", "equal-b"] : ["equal-b", "equal-a"];
  const traversedNames = [];
  const traversedTimes = [];
  let traversal = await timelineStore.listTimelineEntries("workspace-single", { limit: 1, namespace: "tracegarden" }, sessionBody.member.id);
  while (true) {
    const entry = traversal.entries[0];
    if (!entry) break;
    traversedNames.push(entry.observation.name);
    traversedTimes.push(entry.occurredAt);
    if (!traversal.nextCursor) break;
    traversal = await timelineStore.listTimelineEntries("workspace-single", { limit: 1, namespace: "tracegarden", cursor: traversal.nextCursor }, sessionBody.member.id);
  }
  assert.equal(new Set(traversedNames).size, traversedNames.length);
  assert.deepEqual(new Set(traversedNames), new Set(["api", "pending", "running-later", "inserted-newer", "equal-a", "equal-b"]));
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
  assert.deepEqual(attentionHistory.entries.map(({ observation }) => observation.name), ["pending"]);
  assert.equal(attentionHistory.unreadAttentionCount, 1);
  const reviewedAttentionBeforeReview = await timelineStore.listTimelineEntries("workspace-single", { limit: 10, attention: true, unread: false }, sessionBody.member.id);
  assert.deepEqual(reviewedAttentionBeforeReview.entries, []);
  const reviewedAttention = await timelineStore.reviewAttentionItem("workspace-single", sessionBody.member.id, firstHistory.entry.id);
  assert.deepEqual(reviewedAttention, { entryId: firstHistory.entry.id, reviewed: true, unreadCount: 0 });
  const reviewedAgain = await timelineStore.reviewAttentionItem("workspace-single", sessionBody.member.id, firstHistory.entry.id);
  assert.deepEqual(reviewedAgain, { entryId: firstHistory.entry.id, reviewed: false, unreadCount: 0 });
  assert.equal((await timelineStore.unreadAttentionCount("workspace-single", invitedSessionBody.member.id)), 1);
  const reviewedAttentionAfterReview = await timelineStore.listTimelineEntries("workspace-single", { limit: 10, attention: true, unread: false }, sessionBody.member.id);
  assert.deepEqual(reviewedAttentionAfterReview.entries.map(({ observation }) => observation.name), ["pending"]);
  const attentionApi = await fetch(`http://127.0.0.1:${webPort}/api/timeline?limit=10&attention=true&unread=true`, { headers: { cookie: ownerCookie } });
  assert.equal(attentionApi.status, 200);
  assert.equal((await attentionApi.json()).unreadAttentionCount, 0);
  const reviewedAttentionApi = await fetch(`http://127.0.0.1:${webPort}/api/timeline?limit=10&attention=true&unread=false`, { headers: { cookie: ownerCookie } });
  assert.equal(reviewedAttentionApi.status, 200);
  assert.deepEqual((await reviewedAttentionApi.json()).entries.map(({ observation }) => observation.name), ["pending"]);
  const reviewApi = await fetch(`http://127.0.0.1:${webPort}/api/timeline/entries/${encodeURIComponent(firstHistory.entry.id)}/review`, {
    method: "POST",
    headers: { cookie: ownerCookie },
  });
  assert.equal(reviewApi.status, 200);
  assert.deepEqual(await reviewApi.json(), { entryId: firstHistory.entry.id, reviewed: false, unreadCount: 0 });
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
  console.log("PostgreSQL migration, admission, Experiment, normalized Observation, Timeline, rollback, and Better Auth integration smoke passed");
} finally {
  await collector?.close();
  collectorProcess?.kill("SIGTERM");
  await collectorDatabase?.close();
  web?.kill("SIGTERM");
  productionWeb?.kill("SIGTERM");
  await logDatabase?.close();
  removeDatabase();
}
