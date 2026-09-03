import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { createCollectorRuntime } from "../dist/apps/collector/src/main.js";
import { createWebApplication } from "../dist/apps/web/src/server.js";
import {
  collectScopedResources,
  createKubernetesAdapter,
  DeterministicKubernetesAdapter,
  normalizePodObservation,
} from "../dist/packages/cluster/src/index.js";
import {
  PostgresDatabase,
  probePostgresReadiness,
} from "../dist/packages/db/src/index.js";
import { createBetterAuthRuntime } from "../dist/packages/identity/src/index.js";

export const BUN_VERSION = "1.4.0";
export const BUN_IMAGE = "docker.io/oven/bun:1.4.0-distroless@sha256:76caa97ddc0e01333d98c6ab5499539dad4bbceae6237eac83e7853d3826b981";
const POSTGRES_IMAGE = "postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7";
const workspaceId = "workspace-single";
const bunRuntime = globalThis.Bun;
assert.equal(bunRuntime?.version, BUN_VERSION, `Bun ${BUN_VERSION} is required (found ${bunRuntime?.version ?? "non-Bun runtime"})`);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).trim();
}

function imageAvailable(image) {
  try {
    docker(["image", "inspect", image]);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(label, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`${label} did not become ready`, { cause: lastError });
}

async function waitForHttp(url, expectedStatus, timeoutMs = 15_000) {
  let response;
  await waitFor(`HTTP ${url}`, async () => {
    try {
      response = await fetch(url);
      return response.status === expectedStatus;
    } catch {
      return false;
    }
  }, timeoutMs);
  return response;
}

function runChild(command, args, environment, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...result, output });
    };
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("close", (code, signal) => finish({ code, signal }));
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000);
    }, timeoutMs);
  });
}

function waitForChild(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      reject(new Error("child process did not stop"));
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    });
    if (child.exitCode !== null || child.signalCode !== null) {
      settled = true;
      clearTimeout(timer);
      resolve({ code: child.exitCode, signal: child.signalCode });
    }
  });
}

async function nextSseChunk(reader, timeoutMs = 10_000) {
  const result = await Promise.race([
    reader.read(),
    delay(timeoutMs).then(() => { throw new Error("SSE stream did not emit the expected chunk"); }),
  ]);
  if (result.done) throw new Error("SSE stream ended early");
  return new TextDecoder().decode(result.value);
}

function databaseEnvironment(databaseUrl) {
  return {
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    MIGRATION_DATABASE_READY_TIMEOUT_SECONDS: "10",
    MIGRATION_DATABASE_READY_RETRY_SECONDS: "1",
  };
}

const expectContainerBoundary = process.env.BUN_COMPAT_EXPECT_CONTAINER_BOUNDARY === "1";
if (expectContainerBoundary) {
  assert.notEqual(process.getuid?.(), 0, "Bun compatibility container must run as non-root");
  await assert.rejects(
    writeFile(join(process.cwd(), `.tracegarden-bun-read-only-${process.pid}`), "read-only probe"),
    /EACCES|EROFS|permission denied/i,
  );
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "tracegarden-bun-compat-"));
const runTag = `tracegarden-bun-compat-${process.pid}`;
const configuredDatabaseUrl = process.env.BUN_COMPAT_DATABASE_URL?.trim();
const ownsDatabaseContainer = !configuredDatabaseUrl;
const databasePort = 45_000 + (process.pid % 900);
const databaseContainer = `${runTag}-postgres`;
const databaseUrl = configuredDatabaseUrl || `postgresql://tracegarden:local-only@127.0.0.1:${databasePort}/tracegarden`;
let database;
let webApplication;
let collectorRuntime;
let authPool;
let tlsPool;
let adminPool;
let readinessPool;
const signalChildren = [];
const clusterId = `${runTag}-cluster`;
const scope = {
  workspaceId,
  clusterId,
  name: "Bun compatibility Cluster",
  endpoint: "https://bun-compatibility-cluster.example.test",
  namespaces: ["tracegarden"],
  resourceKinds: ["Pod"],
};

try {
  if (ownsDatabaseContainer) {
    assert.equal(imageAvailable(POSTGRES_IMAGE), true, `Bun compatibility requires the preloaded PostgreSQL image ${POSTGRES_IMAGE}; refusing to pull it`);
    try { docker(["rm", "-f", databaseContainer]); } catch { /* run tag was not present */ }
    docker([
      "run", "--pull=never", "-d", "--name", databaseContainer,
      "-p", `127.0.0.1:${databasePort}:5432`,
      "-e", "POSTGRES_DB=tracegarden", "-e", "POSTGRES_USER=tracegarden", "-e", "POSTGRES_PASSWORD=local-only",
      POSTGRES_IMAGE,
    ]);
    await waitFor("PostgreSQL", async () => {
      try {
        docker(["exec", databaseContainer, "pg_isready", "-U", "tracegarden", "-d", "tracegarden"]);
        return true;
      } catch {
        return false;
      }
    }, 30_000);
  }

  const migration = await runChild("bun", ["dist/apps/migrate/src/main.js"], databaseEnvironment(databaseUrl));
  assert.equal(migration.code, 0, `Bun migration process failed: ${migration.output}`);
  assert.match(migration.output, /Tracegarden migrations applied/);

  database = new PostgresDatabase(databaseUrl);
  assert.equal(await database.ping(2_000), true);
  await database.verifyMigrations();

  // Exercise pg's explicit TLS option and a real transaction through the same driver family used by PostgresDatabase.
  tlsPool = new pg.Pool({ connectionString: `${databaseUrl}${databaseUrl.includes("?") ? "&" : "?"}sslmode=disable`, ssl: false, max: 1, connectionTimeoutMillis: 900 });
  assert.equal(tlsPool.options.ssl, false);
  const transactionClient = await tlsPool.connect();
  try {
    await transactionClient.query("CREATE TEMP TABLE tracegarden_bun_transaction (value text NOT NULL)");
    await transactionClient.query("BEGIN");
    await transactionClient.query("INSERT INTO tracegarden_bun_transaction (value) VALUES ($1)", ["committed-by-pg"]);
    await transactionClient.query("ROLLBACK");
    const transactionResult = await transactionClient.query("SELECT count(*)::text AS count FROM tracegarden_bun_transaction");
    assert.deepEqual(transactionResult.rows, [{ count: "0" }]);
  } finally {
    transactionClient.release();
  }
  await tlsPool.end();
  tlsPool = undefined;

  // A real max-one pool must release and destroy a client acquired after the bounded deadline.
  readinessPool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 1, connectionTimeoutMillis: 900 });
  const heldReadinessClient = await readinessPool.connect();
  assert.deepEqual({ total: readinessPool.totalCount, idle: readinessPool.idleCount, waiting: readinessPool.waitingCount }, { total: 1, idle: 0, waiting: 0 });
  const readinessProbe = probePostgresReadiness(readinessPool, 40);
  await waitFor("readiness pool queued waiter", () => readinessPool.waitingCount === 1);
  assert.equal(await readinessProbe, false);
  assert.equal(readinessPool.waitingCount, 1);
  heldReadinessClient.release();
  await waitFor("late readiness client destruction", () => readinessPool.totalCount === 0 && readinessPool.idleCount === 0 && readinessPool.waitingCount === 0);
  assert.equal(await probePostgresReadiness(readinessPool, 500), true);
  assert.deepEqual({ total: readinessPool.totalCount, idle: readinessPool.idleCount, waiting: readinessPool.waitingCount }, { total: 1, idle: 1, waiting: 0 });
  await readinessPool.end();
  readinessPool = undefined;

  await database.clusterScope.save(scope);

  // LISTEN/NOTIFY is proven through a committed timeline write, then through a terminated listener connection and resubscription.
  const notificationIds = [];
  const unsubscribeNotification = await database.timeline.subscribeTimeline((notification) => notificationIds.push(notification.entryId));
  const listenerClient = database.timeline.timelineListenerClient;
  assert.ok(listenerClient, "Postgres timeline listener client was not created");
  const listenerPid = (await listenerClient.query("SELECT pg_backend_pid()")).rows[0]?.pg_backend_pid;
  assert.ok(listenerPid, "Postgres timeline listener PID was not available");
  adminPool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 1, connectionTimeoutMillis: 900 });
  const notificationObservation = normalizePodObservation(scope, {
    kind: "Pod",
    metadata: { name: "bun-notification", namespace: "tracegarden", uid: "bun-notification", resourceVersion: "1" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }, new Date().toISOString());
  const notificationResult = await database.timeline.recordObservation(notificationObservation);
  await waitFor("PostgreSQL NOTIFY delivery", () => notificationIds.includes(notificationResult.entry.id));
  await adminPool.query("SELECT pg_terminate_backend($1)", [listenerPid]);
  await waitFor("PostgreSQL listener failure", () => database.timeline.timelineNotificationsHealthy() === false);
  await unsubscribeNotification();
  assert.equal(database.timeline.timelineListenerClient, null);
  const resubscribedNotifications = [];
  const unsubscribeResubscribed = await database.timeline.subscribeTimeline((notification) => resubscribedNotifications.push(notification.entryId));
  assert.equal(database.timeline.timelineNotificationsHealthy(), true);
  const reconnectObservation = normalizePodObservation(scope, {
    kind: "Pod",
    metadata: { name: "bun-notification-reconnect", namespace: "tracegarden", uid: "bun-notification-reconnect", resourceVersion: "1" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }, new Date().toISOString());
  const reconnectResult = await database.timeline.recordObservation(reconnectObservation);
  await waitFor("PostgreSQL NOTIFY reconnect delivery", () => resubscribedNotifications.includes(reconnectResult.entry.id));
  await unsubscribeResubscribed();
  assert.equal(database.timeline.timelineListenerClient, null);
  await adminPool.end();
  adminPool = undefined;

  // Better Auth is the actual installed integration, not merely an import check.
  authPool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 1, connectionTimeoutMillis: 900 });
  const auth = await createBetterAuthRuntime({
    clientId: "bun-compatibility-client",
    clientSecret: "bun-compatibility-secret",
    redirectUri: "https://bun-compatibility.example.test/api/auth/callback/google",
    issuer: "https://accounts.google.com",
  }, authPool, "https://bun-compatibility.example.test", "bun-compatibility-auth-secret");
  const authStart = await auth.handler(new Request("https://bun-compatibility.example.test/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "google", callbackURL: "/app?lang=en" }),
  }));
  assert.equal(authStart.status, 200);
  const authPayload = await authStart.json();
  assert.equal(authPayload.redirect, true);
  assert.match(authPayload.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.doesNotMatch(authPayload.url, /\/o\/oauth2\/auth\?/);
  const authSession = await auth.handler(new Request("https://bun-compatibility.example.test/api/auth/get-session"));
  assert.equal(authSession.status, 200);
  assert.equal(await authSession.text(), "null");
  await authPool.end();
  authPool = undefined;

  // Exercise the installed Kubernetes owner seam by building a request only; this never sends to a Cluster.
  const ownerKubeConfig = new KubeConfig();
  ownerKubeConfig.loadFromOptions({
    clusters: [{ name: "synthetic-cluster", server: "https://bun-compatibility-cluster.example.test/base", skipTLSVerify: false }],
    users: [{ name: "synthetic-owner", token: "synthetic-owner-auth" }],
    contexts: [{ name: "synthetic-context", cluster: "synthetic-cluster", user: "synthetic-owner" }],
    currentContext: "synthetic-context",
  });
  const ownerApi = ownerKubeConfig.makeApiClient(CoreV1Api);
  const ownerRequest = await ownerApi.api.requestFactory.listNamespacedPod("tracegarden");
  assert.equal(ownerKubeConfig.getCurrentCluster()?.server, "https://bun-compatibility-cluster.example.test/base");
  assert.equal(ownerKubeConfig.getCurrentUser()?.token, "synthetic-owner-auth");
  assert.equal(ownerRequest.getHttpMethod(), "GET");
  assert.equal(ownerRequest.getUrl(), "https://bun-compatibility-cluster.example.test/base/api/v1/namespaces/tracegarden/pods");
  assert.equal(ownerRequest.getHeaders().Authorization, "Bearer synthetic-owner-auth");
  assert.equal(ownerRequest.getHeaders().Accept, "application/json, */*;q=0.8");
  assert.equal(ownerKubeConfig.createDispatcherOptions(ownerKubeConfig.getCurrentCluster(), {}).type, "none");

  // The deterministic adapter still proves app collection behavior without a live Cluster.
  const deterministicAdapter = new DeterministicKubernetesAdapter([{
    kind: "Pod",
    metadata: { name: "bun-deterministic", namespace: "tracegarden", uid: "bun-deterministic", resourceVersion: "1" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }]);
  assert.equal(createKubernetesAdapter({ NODE_ENV: "test" }).kind, "inert");
  const scopedResources = await collectScopedResources(scope, deterministicAdapter);
  assert.equal(scopedResources.length, 1);
  assert.equal(normalizePodObservation(scope, scopedResources[0], new Date().toISOString()).ready, true);
  collectorRuntime = await createCollectorRuntime({
    host: "127.0.0.1",
    port: 0,
    scope,
    adapter: deterministicAdapter,
    observationStore: database.timeline,
  });
  const collected = await collectorRuntime.collectObservations();
  assert.equal(collected.length, 1);
  await collectorRuntime.close();
  collectorRuntime = undefined;

  // Hono's compiled app.fetch serves a request and streams a committed notification under Bun.
  webApplication = await createWebApplication({
    database,
    environment: { ...databaseEnvironment(databaseUrl), HOST: "127.0.0.1", PORT: "0" },
  });
  webApplication.markStarted("127.0.0.1", 0);
  const appRequest = (path, init) => webApplication.app.fetch(new Request(`http://bun.compatibility${path}`, init));
  const health = await appRequest("/health/readiness");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).checks.timeline, "ready");
  const login = await appRequest("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "identity=owner&lang=en",
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie") ?? "";
  const statusResponse = await appRequest("/api/status", { headers: { cookie } });
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).service, "tracegarden-web");

  const rawSse = await appRequest("/api/timeline/stream", { headers: { cookie } });
  assert.equal(rawSse.status, 200);
  assert.equal(rawSse.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.ok(rawSse.body);
  const rawSseReader = rawSse.body.getReader();
  const readyChunk = await nextSseChunk(rawSseReader);
  assert.match(readyChunk, /event: ready/);
  const sseObservation = normalizePodObservation(scope, {
    kind: "Pod",
    metadata: { name: "bun-sse", namespace: "tracegarden", uid: "bun-sse", resourceVersion: "1" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }, new Date().toISOString());
  const sseResult = await database.timeline.recordObservation(sseObservation);
  const hint = await nextSseChunk(rawSseReader);
  assert.match(hint, /event: timeline/);
  assert.match(hint, new RegExp(sseResult.entry.id));
  await rawSseReader.cancel();
  await webApplication.close();
  webApplication = undefined;

  // The actual Bun web entrypoint must release a disconnected SSE client and stop with another active stream.
  const signalWebPort = databasePort + 1;
  const webProcess = spawn("bun", ["dist/apps/web/src/bun.js"], {
    env: { ...process.env, ...databaseEnvironment(databaseUrl), TRACEGARDEN_SSE_BOUNDARY_PROBE: "1", HOST: "127.0.0.1", PORT: String(signalWebPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let webOutput = "";
  webProcess.stdout.on("data", (chunk) => { webOutput += chunk; });
  webProcess.stderr.on("data", (chunk) => { webOutput += chunk; });
  const boundaryEvents = () => webOutput.split("\n").flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return event.kind === "web.sse.boundary" ? [event] : [];
    } catch {
      return [];
    }
  });
  const boundaryCount = (phase) => boundaryEvents().filter((event) => event.phase === phase).length;
  const assertSaturatedBoundary = (phase, occurrence) => {
    const event = boundaryEvents().filter((candidate) => candidate.phase === phase)[occurrence - 1];
    assert.ok(event, `Bun SSE ${phase} boundary was not reported`);
    assert.equal(typeof event.desiredSize, "number");
    assert.ok(event.desiredSize <= 0, `Bun SSE ${phase} boundary was not saturated: ${event.desiredSize}`);
    assert.equal(typeof event.pendingWrites, "number");
    assert.ok(event.pendingWrites > 0, `Bun SSE ${phase} boundary had no pending writer write`);
  };
  const assertReleasedBoundary = (occurrence) => {
    const event = boundaryEvents().filter((candidate) => candidate.phase === "producer-released")[occurrence - 1];
    assert.ok(event, `Bun SSE producer release ${occurrence} was not reported`);
    assert.equal(event.pendingWrites, 0);
    assert.equal(event.appWriteSettled, true);
  };
  const sseBoundaryTimeoutMs = 5_000;
  signalChildren.push(webProcess);
  await waitForHttp(`http://127.0.0.1:${signalWebPort}/health/live`, 200);
  const signalLogin = await fetch(`http://127.0.0.1:${signalWebPort}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "identity=owner&lang=en",
  });
  assert.equal(signalLogin.status, 303);
  const signalCookie = signalLogin.headers.get("set-cookie") ?? "";
  const disconnectedController = new AbortController();
  const disconnectedStream = await fetch(`http://127.0.0.1:${signalWebPort}/api/timeline/stream`, { headers: { cookie: signalCookie }, signal: disconnectedController.signal });
  assert.equal(disconnectedStream.status, 200);
  assert.ok(disconnectedStream.body);
  const disconnectedReader = disconnectedStream.body.getReader();
  assert.match(await nextSseChunk(disconnectedReader), /event: ready/);
  const unreadDisconnectObservation = normalizePodObservation(scope, {
    kind: "Pod",
    metadata: { name: "bun-sse-unread-disconnect", namespace: "tracegarden", uid: "bun-sse-unread-disconnect", resourceVersion: "1" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }, new Date().toISOString());
  await database.timeline.recordObservation(unreadDisconnectObservation);
  await waitFor("Bun SSE unread hint backpressure", () => boundaryCount("backpressured") === 1, sseBoundaryTimeoutMs);
  assert.equal(boundaryCount("producer-released"), 0);
  assertSaturatedBoundary("backpressured", 1);
  disconnectedController.abort();
  await disconnectedReader.cancel().catch(() => undefined);
  await waitFor("Bun SSE blocked producer release", () => boundaryCount("producer-released") === 1, sseBoundaryTimeoutMs);
  assertReleasedBoundary(1);
  await waitFor("Bun SSE disconnect subscription cleanup", () => boundaryCount("subscription-released") === 1, sseBoundaryTimeoutMs);
  await waitFor("Bun SSE disconnect cleanup", async () => {
    const metrics = await fetch(`http://127.0.0.1:${signalWebPort}/metrics`);
    return (await metrics.text()).includes("tracegarden_sse_clients 0") && boundaryCount("client-closed") === 1;
  }, sseBoundaryTimeoutMs);
  const activeStream = await fetch(`http://127.0.0.1:${signalWebPort}/api/timeline/stream`, { headers: { cookie: signalCookie } });
  assert.equal(activeStream.status, 200);
  assert.ok(activeStream.body);
  const activeReader = activeStream.body.getReader();
  assert.match(await nextSseChunk(activeReader), /event: ready/);
  const unreadShutdownObservation = normalizePodObservation(scope, {
    kind: "Pod",
    metadata: { name: "bun-sse-unread-shutdown", namespace: "tracegarden", uid: "bun-sse-unread-shutdown", resourceVersion: "1" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }, new Date().toISOString());
  await database.timeline.recordObservation(unreadShutdownObservation);
  await waitFor("Bun SSE shutdown hint backpressure", () => boundaryCount("backpressured") === 2, sseBoundaryTimeoutMs);
  assert.equal(boundaryCount("producer-released"), 1);
  assertSaturatedBoundary("backpressured", 2);
  webProcess.kill("SIGTERM");
  await waitFor("Bun SSE shutdown blocked producer release", () => boundaryCount("producer-released") === 2, sseBoundaryTimeoutMs);
  assertReleasedBoundary(2);
  await waitFor("Bun SSE shutdown subscription cleanup", () => boundaryCount("subscription-released") === 2, sseBoundaryTimeoutMs);
  const activeStreamResult = await Promise.race([
    (async () => {
      let result;
      do result = await activeReader.read().catch(() => ({ done: true, value: undefined })); while (!result.done);
      return result;
    })(),
    delay(5_000).then(() => { throw new Error("Bun web SIGTERM left the active SSE stream open"); }),
  ]);
  assert.equal(activeStreamResult.done, true);
  const webExit = await waitForChild(webProcess, 5_000);
  assert.equal(webExit.code, 0);
  assert.equal(boundaryCount("client-closed"), 2);
  assert.equal(boundaryCount("subscription-released"), 2);
  signalChildren.pop();

  const signalCollectorPort = databasePort + 2;
  const collectorProcess = spawn(process.execPath, ["dist/apps/collector/src/main.js"], {
    env: { ...process.env, ...databaseEnvironment(databaseUrl), HOST: "127.0.0.1", COLLECTOR_PORT: String(signalCollectorPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  signalChildren.push(collectorProcess);
  await waitForHttp(`http://127.0.0.1:${signalCollectorPort}/health/live`, 200);
  collectorProcess.kill("SIGTERM");
  const collectorExit = await waitForChild(collectorProcess);
  assert.equal(collectorExit.code, 0);
  signalChildren.pop();

  // Backup crypto/filesystem and its child-process pg_dump boundary are exercised with a deterministic local uploader and executable.
  const backup = await import("./backup.mjs");
  const key = Buffer.alloc(32, 7);
  const keyFile = join(temporaryDirectory, "backup.key");
  await writeFile(keyFile, key.toString("hex"), { mode: 0o600 });
  const backupEnvironment = {
    DATABASE_URL: databaseUrl,
    BACKUP_ENDPOINT: "https://storage.invalid",
    BACKUP_BUCKET: "tracegarden-backups",
    BACKUP_SCHEDULE: "0 2 * * *",
    BACKUP_RETENTION_DAYS: "7",
    BACKUP_DESTINATION_SCOPE: "off-vm",
    BACKUP_CREDENTIALS_SOURCE: "kubernetes-secret/tracegarden-backup",
    BACKUP_ENCRYPTION_MECHANISM: "aes-256-gcm",
    BACKUP_ENCRYPTION_KEY_FILE: keyFile,
  };
  let uploadedArtifact;
  const backupResult = await backup.runBackup({
    environment: backupEnvironment,
    dump: async () => Buffer.from("bun-backup-payload"),
    upload: async ({ artifactPath }) => { uploadedArtifact = await readFile(artifactPath); },
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  assert.equal(backupResult.retentionDays, 7);
  assert.deepEqual(backup.decryptBackupBuffer(uploadedArtifact, key), Buffer.from("bun-backup-payload"));
  const fakePgDump = join(temporaryDirectory, "pg_dump");
  await writeFile(fakePgDump, `#!${process.execPath}\nprocess.stdout.write('bun-pg-dump')\n`);
  await chmod(fakePgDump, 0o755);
  const dumped = await backup.runPgDump(databaseUrl, { ...process.env, PATH: `${temporaryDirectory}:${process.env.PATH ?? ""}` });
  assert.equal(dumped.toString(), "bun-pg-dump");
  assert.equal(createHash("sha256").update(uploadedArtifact).digest().length, 32);

  const cleanupPool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 1, connectionTimeoutMillis: 900 });
  try {
    await cleanupPool.query("DELETE FROM tracegarden_ingestion_checkpoints WHERE cluster_id = $1", [clusterId]);
    await cleanupPool.query("DELETE FROM tracegarden_observations WHERE cluster_id = $1", [clusterId]);
    await cleanupPool.query("DELETE FROM tracegarden_clusters WHERE id = $1", [clusterId]);
  } finally {
    await cleanupPool.end();
  }
  console.log(`Bun ${BUN_VERSION} compiled-ESM compatibility passed: Hono request/SSE abort, pg transaction/TLS/readiness/LISTEN reconnect, Better Auth, Kubernetes deterministic adapter, migration/backup crypto-fs-child-process, and signals`);
} finally {
  for (const child of signalChildren) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await Promise.all(signalChildren.map((child) => waitForChild(child, 5_000).catch(() => undefined)));
  if (collectorRuntime) await collectorRuntime.close().catch(() => undefined);
  if (webApplication) await webApplication.close().catch(() => undefined);
  if (authPool) await authPool.end().catch(() => undefined);
  if (tlsPool) await tlsPool.end().catch(() => undefined);
  if (adminPool) await adminPool.end().catch(() => undefined);
  if (readinessPool) await readinessPool.end().catch(() => undefined);
  if (database) await database.close().catch(() => undefined);
  if (databaseUrl) {
    try {
      const cleanupPool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 1, connectionTimeoutMillis: 900 });
      await cleanupPool.query("DELETE FROM tracegarden_ingestion_checkpoints WHERE cluster_id = $1", [clusterId]);
      await cleanupPool.query("DELETE FROM tracegarden_observations WHERE cluster_id = $1", [clusterId]);
      await cleanupPool.query("DELETE FROM tracegarden_clusters WHERE id = $1", [clusterId]);
      await cleanupPool.end();
    } catch { /* cleanup cannot mask a compatibility failure */ }
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
  if (ownsDatabaseContainer) {
    try { docker(["rm", "-f", databaseContainer]); } catch { /* cleanup is best effort after the bounded run */ }
  }
}
