import assert from "node:assert/strict";
import { ServerResponse } from "node:http";
import { CollectorRecoveryError, collectorStatus, createCollectorRuntime } from "../dist/apps/collector/src/main.js";
import { createWebRuntime, renderApplicationPage, renderStatusPage } from "../dist/apps/web/src/server.js";
import { createDatabase, MemoryAdmissionStore, MemoryClusterScopeStore, MemoryDatabase, MemoryObservationStore, TimelineQueryValidationError, parseTimelineNotification } from "../dist/packages/db/src/index.js";
import { capabilities, createBetterAuthRuntime, createIdentityAdapter, GOOGLE_ISSUER, googleOAuthConfig, hasCapability, LocalIdentityAdapter } from "../dist/packages/identity/src/index.js";
import { catalogs, parseLanguage } from "../dist/packages/i18n/src/index.js";
import { confirmCorrelationSuggestion, correlationSignalsBetween, createExperiment, ExperimentLifecycleError, ExperimentValidationError, hasCorrelationReview, hasExperimentWrite, hasRetentionManagement, parseExperimentInput, rejectCorrelationSuggestion, runRetentionCleanup, suggestCorrelationCandidates, updateRetentionPolicy } from "../dist/packages/domain/src/index.js";
import {
  boundRecentLogWindow,
  ConfiguredKubernetesLogAdapter,
  FakeKubernetesLogAdapter,
  LOG_MAX_BYTES,
  LOG_MAX_LINES,
  productionKubernetesLogConfiguration,
  requestRecentLogWindow,
  validateRecentLogWindowInput,
} from "../dist/packages/logs/src/index.js";
import {
  collectScopedResources,
  compareResourceVersions,
  configureClusterScope,
  ConfiguredKubernetesAdapter,
  DeterministicKubernetesAdapter,
  createKubernetesAdapter,
  hasClusterConfigureCapability,
  normalizeObservation,
  normalizePodObservation,
  productionKubernetesConfiguration,
  validateClusterScopeInput,
} from "../dist/packages/cluster/src/index.js";
import { createTelemetry } from "../dist/packages/telemetry/src/index.js";

const exporterFailureTelemetry = createTelemetry({
  serviceName: "tracegarden-test",
  structuredLog: () => { throw new Error("exporter unavailable"); },
  trace: () => { throw new Error("exporter unavailable"); },
  metric: () => { throw new Error("exporter unavailable"); },
});
const exporterCorrelation = exporterFailureTelemetry.correlation("request-test");
exporterFailureTelemetry.log("info", "test.signal", exporterCorrelation, { body: "must-not-appear", operation: "health" });
const exporterSpan = exporterFailureTelemetry.startSpan("test.span", exporterCorrelation, { operation: "health" });
exporterSpan.end({ outcome: "ok" });
exporterFailureTelemetry.increment("tracegarden_test_total", 1, { result: "ok" }, exporterCorrelation);
assert.match(exporterFailureTelemetry.metricsText(), /tracegarden_test_total\{result="ok"\} 1/);
assert.equal(JSON.stringify(exporterFailureTelemetry.signals()).includes("must-not-appear"), false);
const boundedTelemetry = createTelemetry({ serviceName: "tracegarden-cardinality" });
for (let index = 0; index < 1_100; index += 1) {
  boundedTelemetry.increment("tracegarden_cardinality_total", 1, { series: `value-${index}`, extra: "bounded", ignored: "bounded" });
}
const cardinalitySamples = boundedTelemetry.metricsText().split("\n").filter((line) => line.startsWith("tracegarden_cardinality_total{"));
assert.equal(cardinalitySamples.length, 1_000);
assert.ok(cardinalitySamples.every((line) => (line.match(/=/g) ?? []).length <= 8));

assert.equal(parseLanguage(undefined), "zh-CN");
assert.equal(parseLanguage("en"), "en");
assert.equal(catalogs["zh-CN"].statusTitle, "应用状态");
assert.equal(catalogs.en.statusTitle, "Application status");
assert.match(renderStatusPage("zh-CN", true), /应用状态/);
assert.match(renderStatusPage("en", true), /Application status/);
assert.ok(!renderStatusPage("en", true).includes("DATABASE_URL"));

const identityAdapter = new LocalIdentityAdapter();
const googleConfig = googleOAuthConfig({
  NODE_ENV: "production",
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-secret",
  GOOGLE_REDIRECT_URI: "https://tracegarden.test/api/auth/callback/google",
});
const googleAdapter = createIdentityAdapter({
  NODE_ENV: "production",
  GOOGLE_CLIENT_ID: googleConfig.clientId,
  GOOGLE_CLIENT_SECRET: googleConfig.clientSecret,
  GOOGLE_REDIRECT_URI: googleConfig.redirectUri,
});
assert.equal(googleAdapter.kind, "google");
const admissionStore = new MemoryAdmissionStore();
const ownerIdentity = identityAdapter.resolve("owner");
assert.ok(ownerIdentity);
const rejectedIdentity = identityAdapter.resolve("rejected");
assert.ok(rejectedIdentity);
const rejectedFirstStore = new MemoryAdmissionStore();
const rejectedFirstAdmission = await rejectedFirstStore.admit(rejectedIdentity);
assert.equal(rejectedFirstAdmission.admitted, false);
assert.equal(rejectedFirstStore.memberCount(), 0);
const ownerAdmission = await admissionStore.admit(ownerIdentity);
assert.equal(ownerAdmission.admitted, true);
const ownerActor = ownerAdmission.session.member;
assert.equal(ownerActor.role, "owner");
assert.ok(hasCapability(ownerActor, capabilities.membershipManage));
assert.equal((await admissionStore.getSession(ownerAdmission.session.token))?.member.identity.subject, "owner");
await assert.rejects(() => admissionStore.createInvitation("missing-actor@example.test"), /Membership actor is required/);
const rejectedAdmission = await admissionStore.admit(rejectedIdentity);
assert.equal(rejectedAdmission.admitted, false);
assert.equal(admissionStore.memberCount(), 1);
const invitedIdentity = identityAdapter.resolve("invited");
assert.ok(invitedIdentity);
const invitedInvitation = await admissionStore.createInvitation(` ${invitedIdentity.email.toUpperCase()} `, ownerActor);
assert.equal(invitedInvitation.email, invitedIdentity.email);
const revokedInvitation = await admissionStore.createInvitation(rejectedIdentity.email, ownerActor);
assert.ok(await admissionStore.revokeInvitation(revokedInvitation.id, ownerActor));
assert.equal((await admissionStore.admit(rejectedIdentity)).admitted, false);
const invitedAdmission = await admissionStore.admit(invitedIdentity);
assert.equal(invitedAdmission.admitted, true);
if (invitedAdmission.admitted) {
  assert.equal(invitedAdmission.session.member.role, "viewer");
  assert.equal((await admissionStore.admit(invitedIdentity)).session.member.id, invitedAdmission.session.member.id);
  await assert.rejects(() => admissionStore.createInvitation("other@example.test", invitedAdmission.session.member), /Missing capability/);
}
const sameEmailDifferentIdentity = new LocalIdentityAdapter([{
  key: "same-email",
  issuer: "https://local.tracegarden.test",
  subject: "same-email",
  email: invitedIdentity.email,
  displayName: "Same Email Identity",
}]).resolve("same-email");
assert.ok(sameEmailDifferentIdentity);
assert.equal((await admissionStore.admit(sameEmailDifferentIdentity)).admitted, false);
assert.equal(admissionStore.memberCount(), 2);
if (invitedAdmission.admitted) {
  const operator = await admissionStore.assignMemberRole(invitedAdmission.session.member.id, "operator", ownerActor);
  assert.ok(operator);
  assert.ok(hasCapability(operator, capabilities.experimentWrite));
  assert.ok(!hasCapability(operator, capabilities.membershipManage));
  assert.equal((await admissionStore.getSession(invitedAdmission.session.token))?.member.role, "operator");
  await assert.rejects(() => admissionStore.assignMemberRole(ownerActor.id, "viewer", operator), /Missing capability/);
}
const auditRecords = await admissionStore.listAuditRecords();
assert.deepEqual(auditRecords.map(({ action }) => action), [
  "member.admitted",
  "invitation.created",
  "invitation.created",
  "invitation.revoked",
  "member.admitted",
  "member.role_changed",
]);
assert.ok(auditRecords.every((record) => !JSON.stringify(record).includes("token")));
assert.equal((await admissionStore.listInvitations()).find(({ id }) => id === invitedInvitation.id)?.acceptedAt !== null, true);
const renamedOwner = { ...ownerIdentity, email: "renamed@example.test", displayName: "Renamed Owner" };
const renamedAdmission = await admissionStore.admit(renamedOwner);
assert.equal(renamedAdmission.admitted, true);
if (renamedAdmission.admitted && ownerAdmission.admitted) {
  assert.equal(renamedAdmission.session.member.id, ownerAdmission.session.member.id);
  assert.equal(renamedAdmission.session.member.identity.email, "renamed@example.test");
}
assert.equal(admissionStore.memberCount(), 2);

const productionTimeline = new MemoryObservationStore("production-test-cursor-secret");
const productionRuntime = await createWebRuntime({
  database: {
    kind: "postgres",
    admission: new MemoryAdmissionStore({ issuer: GOOGLE_ISSUER, subject: "test-google-subject" }),
    clusterScope: new MemoryClusterScopeStore(),
    timeline: productionTimeline,
    experiments: productionTimeline,
    migrate: async () => {},
    ping: async () => true,
    close: async () => {},
    betterAuth: async (environment) => createBetterAuthRuntime(
      googleConfig,
      undefined,
      environment.BETTER_AUTH_URL ?? "https://tracegarden.test",
      environment.BETTER_AUTH_SECRET ?? "",
    ),
  },
  environment: {
    NODE_ENV: "production",
    GOOGLE_CLIENT_ID: "test-client",
    GOOGLE_CLIENT_SECRET: "test-secret",
    GOOGLE_REDIRECT_URI: "https://tracegarden.test/api/auth/callback/google",
    BETTER_AUTH_SECRET: "test-secret-secret",
    TIMELINE_CURSOR_SECRET: "test-timeline-cursor-secret",
    BETTER_AUTH_URL: "https://tracegarden.test",
    TRACEGARDEN_BOOTSTRAP_ISSUER: GOOGLE_ISSUER,
    TRACEGARDEN_BOOTSTRAP_SUBJECT: "test-google-subject",
    HOST: "127.0.0.1",
  },
  port: 43204,
});
try {
  const productionLogin = await fetch("http://127.0.0.1:43204/?lang=en");
  const productionLoginBody = await productionLogin.text();
  assert.match(productionLoginBody, /Sign in with Google/);
  assert.doesNotMatch(productionLoginBody, /test-secret/);
  const googleRedirect = await fetch("http://127.0.0.1:43204/auth/google", { redirect: "manual" });
  assert.equal(googleRedirect.status, 302);
  const googleLocation = googleRedirect.headers.get("location") ?? "";
  assert.match(googleLocation, /client_id=test-client/);
  assert.match(googleLocation, /redirect_uri=https%3A%2F%2Ftracegarden.test%2Fapi%2Fauth%2Fcallback%2Fgoogle/);
  assert.doesNotMatch(googleLocation, /test-secret/);
} finally {
  await productionRuntime.close();
}
await assert.rejects(
  createWebRuntime({
    database: {
      kind: "postgres",
      admission: new MemoryAdmissionStore({ issuer: GOOGLE_ISSUER, subject: "injected-experiment" }),
      clusterScope: new MemoryClusterScopeStore(),
      timeline: productionTimeline,
      experiments: productionTimeline,
      migrate: async () => {},
      ping: async () => true,
      close: async () => {},
    },
    experimentStore: new MemoryObservationStore("injected-experiment-secret"),
    environment: {
      NODE_ENV: "production",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GOOGLE_REDIRECT_URI: "https://tracegarden.test/api/auth/callback/google",
      BETTER_AUTH_SECRET: "test-secret-secret",
      TIMELINE_CURSOR_SECRET: "test-timeline-cursor-secret",
      BETTER_AUTH_URL: "https://tracegarden.test",
      TRACEGARDEN_BOOTSTRAP_ISSUER: GOOGLE_ISSUER,
      TRACEGARDEN_BOOTSTRAP_SUBJECT: "injected-experiment",
    },
  }),
  /Production Experiment must use the database-owned durable store/,
);
await assert.rejects(
  createWebRuntime({
    database: {
      kind: "postgres",
      admission: new MemoryAdmissionStore({ issuer: GOOGLE_ISSUER, subject: "test-google-subject" }),
      clusterScope: new MemoryClusterScopeStore(),
      migrate: async () => {},
      ping: async () => true,
      close: async () => {},
    },
    timelineStore: new MemoryObservationStore("injected-test-cursor-secret"),
    environment: {
      NODE_ENV: "production",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GOOGLE_REDIRECT_URI: "https://tracegarden.test/api/auth/callback/google",
      BETTER_AUTH_SECRET: "test-secret-secret",
      TIMELINE_CURSOR_SECRET: "test-timeline-cursor-secret",
      BETTER_AUTH_URL: "https://tracegarden.test",
      TRACEGARDEN_BOOTSTRAP_ISSUER: GOOGLE_ISSUER,
      TRACEGARDEN_BOOTSTRAP_SUBJECT: "test-google-subject",
    },
  }),
  /Production Timeline must use the database-owned durable store/,
);
await assert.rejects(
  createWebRuntime({
    database: {
      kind: "postgres",
      admission: new MemoryAdmissionStore({ issuer: GOOGLE_ISSUER, subject: "missing-timeline" }),
      clusterScope: new MemoryClusterScopeStore(),
      migrate: async () => {},
      ping: async () => true,
      close: async () => {},
    },
    environment: {
      NODE_ENV: "production",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GOOGLE_REDIRECT_URI: "https://tracegarden.test/api/auth/callback/google",
      BETTER_AUTH_SECRET: "test-secret-secret",
      TIMELINE_CURSOR_SECRET: "test-timeline-cursor-secret",
      BETTER_AUTH_URL: "https://tracegarden.test",
      TRACEGARDEN_BOOTSTRAP_ISSUER: GOOGLE_ISSUER,
      TRACEGARDEN_BOOTSTRAP_SUBJECT: "missing-timeline",
    },
  }),
  /Production Timeline must use the database-owned durable store/,
);
await assert.rejects(
  createWebRuntime({
    database: { kind: "postgres", migrate: async () => {}, ping: async () => true, close: async () => {} },
    environment: {
      NODE_ENV: "production",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GOOGLE_REDIRECT_URI: "https://tracegarden.test/api/auth/callback/google",
      BETTER_AUTH_SECRET: "test-secret-secret",
      TIMELINE_CURSOR_SECRET: "test-timeline-cursor-secret",
      BETTER_AUTH_URL: "https://tracegarden.test",
      TRACEGARDEN_BOOTSTRAP_ISSUER: GOOGLE_ISSUER,
      TRACEGARDEN_BOOTSTRAP_SUBJECT: "google-subject",
    },
  }),
  /Production admission must use the database-owned durable store/,
);
await assert.rejects(
  createWebRuntime({
    database: {
      kind: "postgres",
      admission: new MemoryAdmissionStore({ issuer: GOOGLE_ISSUER, subject: "google-subject" }),
      clusterScope: new MemoryClusterScopeStore(),
      migrate: async () => {},
      ping: async () => true,
      close: async () => {},
    },
    admissionStore: new MemoryAdmissionStore({ issuer: GOOGLE_ISSUER, subject: "google-subject" }),
    environment: {
      NODE_ENV: "production",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GOOGLE_REDIRECT_URI: "https://tracegarden.test/api/auth/callback/google",
      BETTER_AUTH_SECRET: "test-secret-secret",
      TIMELINE_CURSOR_SECRET: "test-timeline-cursor-secret",
      BETTER_AUTH_URL: "https://tracegarden.test",
      TRACEGARDEN_BOOTSTRAP_ISSUER: GOOGLE_ISSUER,
      TRACEGARDEN_BOOTSTRAP_SUBJECT: "google-subject",
    },
  }),
  /Production admission must use the database-owned durable store/,
);

const callbackSession = {
  token: "better-auth-session-token",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  subject: "google-subject",
  user: { id: "better-auth-user", email: "owner@example.test", name: "Google Owner" },
};
const callbackAuthRuntime = {
  handler: async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/callback/google") {
      return new Response(null, {
        status: 302,
        headers: [
          ["location", "/app?lang=en"],
          ["set-cookie", "first=one; Path=/"],
          ["set-cookie", "second=two; Path=/"],
        ],
      });
    }
    return new Response(null, { status: 204 });
  },
  session: async () => callbackSession,
};
const callbackAdmissionStore = new MemoryAdmissionStore({ issuer: GOOGLE_ISSUER, subject: "google-subject" });
const callbackTimeline = new MemoryObservationStore("production-test-cursor-secret");
const callbackRuntime = await createWebRuntime({
  database: {
    kind: "postgres",
    admission: callbackAdmissionStore,
    clusterScope: new MemoryClusterScopeStore(),
    timeline: callbackTimeline,
    experiments: callbackTimeline,
    migrate: async () => {},
    ping: async () => true,
    close: async () => {},
    betterAuth: async () => callbackAuthRuntime,
  },
  environment: {
    NODE_ENV: "production",
    GOOGLE_CLIENT_ID: "test-client",
    GOOGLE_CLIENT_SECRET: "test-secret",
    GOOGLE_REDIRECT_URI: "https://tracegarden.test/api/auth/callback/google",
    BETTER_AUTH_SECRET: "test-secret-secret",
    TIMELINE_CURSOR_SECRET: "test-timeline-cursor-secret",
    BETTER_AUTH_URL: "https://tracegarden.test",
    TRACEGARDEN_BOOTSTRAP_ISSUER: GOOGLE_ISSUER,
    TRACEGARDEN_BOOTSTRAP_SUBJECT: "google-subject",
    HOST: "127.0.0.1",
  },
  port: 43206,
});
try {
  const callback = await fetch("http://127.0.0.1:43206/api/auth/callback/google?code=local", { redirect: "manual" });
  assert.equal(callback.status, 302);
  assert.deepEqual(callback.headers.getSetCookie(), ["first=one; Path=/", "second=two; Path=/"]);
  const callbackApiSession = await fetch("http://127.0.0.1:43206/api/session");
  assert.equal(callbackApiSession.status, 200);
  const callbackMember = await callbackApiSession.json();
  assert.equal(callbackMember.member.identity.issuer, GOOGLE_ISSUER);
  assert.equal(callbackMember.member.identity.subject, "google-subject");
} finally {
  await callbackRuntime.close();
}
await assert.rejects(
  createWebRuntime({
    database: {
      kind: "postgres",
      admission: new MemoryAdmissionStore({ issuer: GOOGLE_ISSUER, subject: "google-subject" }),
      clusterScope: new MemoryClusterScopeStore(),
      timeline: productionTimeline,
      experiments: productionTimeline,
      migrate: async () => {},
      ping: async () => true,
      close: async () => {},
    },
    environment: {
      NODE_ENV: "production",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GOOGLE_REDIRECT_URI: "https://tracegarden.test/api/auth/callback/google",
      BETTER_AUTH_SECRET: "test-secret-secret",
      TIMELINE_CURSOR_SECRET: "test-timeline-cursor-secret",
      BETTER_AUTH_URL: "http://127.0.0.1:43207",
      TRACEGARDEN_BOOTSTRAP_ISSUER: GOOGLE_ISSUER,
      TRACEGARDEN_BOOTSTRAP_SUBJECT: "google-subject",
    },
    port: 43207,
  }),
  /BETTER_AUTH_URL must be HTTPS in production/,
);

const restrictedSession = {
  token: "capability-test-session",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  member: {
    id: "restricted-member",
    workspaceId: "workspace-single",
    identity: ownerIdentity,
    role: "viewer",
    capabilities: [],
  },
};
const restrictedStore = {
  admit: async () => ({ admitted: true, session: restrictedSession }),
  getSession: async (token) => token === restrictedSession.token ? restrictedSession : null,
};
const restrictedRuntime = await createWebRuntime({
  database: new MemoryDatabase(),
  admissionStore: restrictedStore,
  identityAdapter,
  environment: { NODE_ENV: "test", HOST: "127.0.0.1" },
  port: 43205,
});
try {
  const restrictedLogin = await fetch("http://127.0.0.1:43205/auth/login", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "identity=owner&lang=en",
  });
  assert.equal(restrictedLogin.status, 303);
  const restrictedApp = await fetch("http://127.0.0.1:43205/app?lang=en", {
    headers: { cookie: restrictedLogin.headers.get("set-cookie") ?? "" },
  });
  assert.equal(restrictedApp.status, 403);
  assert.match(await restrictedApp.text(), /Workspace access denied/);
} finally {
  await restrictedRuntime.close();
}

const database = new MemoryDatabase();
assert.equal(await database.ping(), false);
await database.migrate();
assert.equal(await database.ping(), true);
const exporterWebRuntime = await createWebRuntime({
  database: new MemoryDatabase(),
  identityAdapter: new LocalIdentityAdapter(),
  telemetry: exporterFailureTelemetry,
  environment: { NODE_ENV: "test", HOST: "127.0.0.1" },
  port: 43215,
});
try {
  const liveHealth = await fetch("http://127.0.0.1:43215/health/live");
  assert.equal(liveHealth.status, 200);
  const readyHealth = await fetch("http://127.0.0.1:43215/health/readiness");
  assert.equal(readyHealth.status, 200);
  const readyHealthBody = await readyHealth.json();
  assert.deepEqual({ startup: readyHealthBody.startup, readiness: readyHealthBody.readiness, liveness: readyHealthBody.liveness }, { startup: "ready", readiness: "ready", liveness: "alive" });
  const exporterMetrics = await fetch("http://127.0.0.1:43215/metrics");
  assert.equal(exporterMetrics.status, 200);
  const exporterMetricsBody = await exporterMetrics.text();
  assert.match(exporterMetricsBody, /tracegarden_sse_clients/);
  assert.match(exporterMetricsBody, /tracegarden_timeline_cursor_lag_entries/);
  assert.match(exporterMetricsBody, /tracegarden_database_pool_idle/);
  assert.match(exporterMetricsBody, /tracegarden_migration_status/);
  const untrustedRequestId = "protected-request-correlation";
  const tracedHealth = await fetch("http://127.0.0.1:43215/health/live", { headers: { "x-request-id": untrustedRequestId } });
  const serverRequestId = tracedHealth.headers.get("x-request-id") ?? "";
  assert.notEqual(serverRequestId, untrustedRequestId);
  const traceparent = tracedHealth.headers.get("traceparent") ?? "";
  const requestStart = exporterFailureTelemetry.signals().find((signal) => signal.kind === "trace" && signal.event === "span.start" && signal.correlation.requestId === serverRequestId);
  assert.ok(requestStart);
  assert.equal(traceparent, `00-${requestStart.correlation.traceId}-${requestStart.correlation.spanId}-01`);
  assert.doesNotMatch(JSON.stringify(exporterFailureTelemetry.signals()), /protected-request-correlation/);
} finally {
  await exporterWebRuntime.close();
}
const dependencyDatabase = new MemoryDatabase();
let dependencyReady = true;
dependencyDatabase.ping = async () => dependencyReady;
const dependencyRuntime = await createWebRuntime({
  database: dependencyDatabase,
  identityAdapter: new LocalIdentityAdapter(),
  environment: { NODE_ENV: "test", HOST: "127.0.0.1" },
  port: 43217,
});
try {
  dependencyReady = false;
  const dependencyReadiness = await fetch("http://127.0.0.1:43217/health/readiness");
  assert.equal(dependencyReadiness.status, 503);
  const completedStartup = await fetch("http://127.0.0.1:43217/health/startup");
  assert.equal(completedStartup.status, 200);
  assert.equal((await completedStartup.json()).startup, "ready");
  const conservativeLiveness = await fetch("http://127.0.0.1:43217/health/live");
  assert.equal(conservativeLiveness.status, 200);
  const degradedMetrics = await fetch("http://127.0.0.1:43217/metrics");
  assert.equal(degradedMetrics.status, 200);
} finally {
  await dependencyRuntime.close();
}
const listenFailureDatabase = new MemoryDatabase();
listenFailureDatabase.timeline.subscribeTimeline = async () => { throw new Error("LISTEN unavailable"); };
const listenFailureRuntime = await createWebRuntime({
  database: listenFailureDatabase,
  identityAdapter: new LocalIdentityAdapter(),
  environment: { NODE_ENV: "test", HOST: "127.0.0.1" },
  port: 43218,
});
try {
  const listenFailureReadiness = await fetch("http://127.0.0.1:43218/health/readiness");
  assert.equal(listenFailureReadiness.status, 503);
  assert.equal((await listenFailureReadiness.json()).checks.timeline, "not-ready");
  const listenFailureLogin = await fetch("http://127.0.0.1:43218/auth/login", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "identity=owner&lang=en",
  });
  const listenFailureStream = await fetch("http://127.0.0.1:43218/api/timeline/stream", {
    headers: { cookie: listenFailureLogin.headers.get("set-cookie") ?? "" },
  });
  assert.equal(listenFailureStream.status, 503);
} finally {
  await listenFailureRuntime.close();
}
const bindFailureWebTelemetry = createTelemetry({ serviceName: "tracegarden-web-bind-test" });
const occupiedWebPort = 43221;
const occupiedWebRuntime = await createWebRuntime({
  database: new MemoryDatabase(),
  identityAdapter: new LocalIdentityAdapter(),
  environment: { NODE_ENV: "test", HOST: "127.0.0.1" },
  port: occupiedWebPort,
});
try {
  await assert.rejects(
    createWebRuntime({
      database: new MemoryDatabase(),
      identityAdapter: new LocalIdentityAdapter(),
      telemetry: bindFailureWebTelemetry,
      environment: { NODE_ENV: "test", HOST: "127.0.0.1" },
      port: occupiedWebPort,
    }),
    /EADDRINUSE/,
  );
  const webBindSignals = bindFailureWebTelemetry.signals();
  assert.ok(webBindSignals.some((signal) => signal.kind === "log" && signal.event === "web.startup.failure"));
  assert.equal(webBindSignals.some((signal) => signal.kind === "log" && signal.event === "web.started"), false);
} finally {
  await occupiedWebRuntime.close();
}

const scopeInput = {
  clusterId: "lab-cluster",
  name: "Personal lab",
  endpoint: "https://cluster.example.test",
  namespaces: ["tracegarden", "default"],
  resourceKinds: ["Pod", "Deployment"],
};
assert.equal(validateClusterScopeInput(scopeInput).valid, true);
assert.equal(validateClusterScopeInput({ ...scopeInput, namespaces: ["Not A Namespace"] }).valid, false);
assert.equal(validateClusterScopeInput({ ...scopeInput, resourceKinds: ["Secret"] }).valid, false);
const deterministic = new DeterministicKubernetesAdapter([
  { kind: "Pod", metadata: { name: "in-scope", namespace: "tracegarden", uid: "pod-uid-1", resourceVersion: "1" }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } },
  { kind: "Pod", metadata: { name: "wrong-namespace", namespace: "kube-system" } },
  { kind: "Secret", metadata: { name: "wrong-kind", namespace: "tracegarden" } },
]);
const scopeStore = new MemoryClusterScopeStore();
const ownerMember = ownerAdmission.admitted ? ownerAdmission.session.member : null;
assert.ok(ownerMember);
const savedScope = ownerMember ? await configureClusterScope(ownerMember, scopeStore, scopeInput) : null;
assert.equal(savedScope?.clusterId, "lab-cluster");
assert.ok(ownerMember && hasClusterConfigureCapability(ownerMember));
assert.ok(ownerMember && hasRetentionManagement(ownerMember));
const retentionTimeline = new MemoryObservationStore(scopeStore);
assert.equal((await retentionTimeline.getRetentionPolicy("workspace-single")).retentionDays, 90);
if (savedScope && ownerMember) {
  const retentionObservation = (uid, observedAt) => normalizePodObservation(savedScope, {
    kind: "Pod",
    metadata: { name: uid, namespace: "tracegarden", uid, resourceVersion: uid },
    status: { phase: "Running" },
  }, observedAt);
  await retentionTimeline.recordObservation(retentionObservation("retention-old", "2025-12-31T00:00:00.000Z"));
  const retentionAttention = retentionObservation("retention-attention", "2025-12-31T00:00:00.000Z");
  const retentionAttentionResult = await retentionTimeline.recordObservation({ ...retentionAttention, phase: "Failed", attention: true, attentionReason: "pod_not_ready" });
  await retentionTimeline.reviewAttentionItem("workspace-single", ownerMember.id, retentionAttentionResult.entry.id);
  await retentionTimeline.recordObservation(retentionObservation("retention-boundary", "2026-01-01T00:00:00.000Z"));
  await updateRetentionPolicy(ownerMember, retentionTimeline, { retentionDays: 1 });
  await assert.rejects(() => updateRetentionPolicy(invitedAdmission.admitted ? invitedAdmission.session.member : ownerMember, retentionTimeline, 7), /Missing capability/);
  const cleanup = await runRetentionCleanup(ownerMember, retentionTimeline, "2026-01-02T00:00:00.000Z");
  assert.equal(cleanup.deletedObservations, 2);
  assert.equal(cleanup.deletedTimelineEntries, 2);
  assert.equal(cleanup.protectedObservations, 0);
  assert.equal((await retentionTimeline.countObservations("workspace-single")), 1);
  assert.equal(retentionTimeline.attentionReviews.size, 0);
  assert.equal(retentionTimeline.ingestionOrders.size, 1);
  const retry = await runRetentionCleanup(ownerMember, retentionTimeline, "2026-01-02T00:00:00.000Z");
  assert.equal(retry.deletedObservations, 0);
  assert.equal(retry.failures, 0);
}
const scopedResources = savedScope ? await collectScopedResources(savedScope, deterministic) : [];
assert.deepEqual(scopedResources.map((resource) => resource.metadata.name), ["in-scope"]);
assert.equal(deterministic.requests[0]?.clusterId, "lab-cluster");
const normalizedPod = savedScope ? normalizePodObservation(savedScope, scopedResources[0], "2026-01-01T00:00:00.000Z") : null;
assert.equal(normalizedPod?.sourceIdentity, "lab-cluster:pod-uid-1");
assert.equal(normalizedPod?.phase, "Running");
assert.equal(normalizedPod?.ready, true);
if (savedScope && normalizedPod) {
  const ownershipTimeline = new MemoryObservationStore(scopeStore);
  const validCheckpoint = {
    workspaceId: savedScope.workspaceId,
    clusterId: savedScope.clusterId,
    namespace: "tracegarden",
    resourceKind: "Pod",
    resourceVersion: "1",
  };
  const mismatchedCheckpoint = { ...validCheckpoint, clusterId: "foreign-cluster" };
  await assert.rejects(
    () => ownershipTimeline.recordObservationsAndCheckpoint([normalizedPod], mismatchedCheckpoint),
    /Ingestion Checkpoint Cluster does not belong to its Workspace/,
  );
  assert.equal(await ownershipTimeline.countObservations(savedScope.workspaceId), 0);
  const mismatchedObservation = normalizePodObservation({ ...savedScope, clusterId: "foreign-cluster" }, {
    kind: "Pod",
    metadata: { name: "foreign-observation", namespace: "tracegarden", uid: "foreign-observation", resourceVersion: "1" },
    status: { phase: "Running" },
  }, "2026-01-01T00:00:01.000Z");
  await assert.rejects(
    () => ownershipTimeline.recordObservation(mismatchedObservation),
    /Observation Cluster does not belong to its Workspace/,
  );
  assert.equal(await ownershipTimeline.countObservations(savedScope.workspaceId), 0);
  const validBatchObservation = normalizePodObservation(savedScope, {
    kind: "Pod",
    metadata: { name: "valid-batch-observation", namespace: "tracegarden", uid: "valid-batch-observation", resourceVersion: "1" },
    status: { phase: "Running" },
  }, "2026-01-01T00:00:02.000Z");
  await assert.rejects(
    () => ownershipTimeline.recordObservations([validBatchObservation, mismatchedObservation]),
    /Observation Cluster does not belong to its Workspace/,
  );
  assert.equal(await ownershipTimeline.countObservations(savedScope.workspaceId), 0);
  await assert.rejects(
    () => ownershipTimeline.recordObservationsAndCheckpoint([mismatchedObservation], validCheckpoint),
    /Observation Cluster does not belong to its Workspace/,
  );
  await assert.rejects(
    () => ownershipTimeline.advanceIngestionCheckpoint(mismatchedCheckpoint),
    /Ingestion Checkpoint Cluster does not belong to its Workspace/,
  );
  assert.equal(await ownershipTimeline.getIngestionCheckpoint(savedScope.workspaceId, savedScope.clusterId, "Pod", "tracegarden"), null);
  await ownershipTimeline.advanceIngestionCheckpoint(validCheckpoint);
  await assert.rejects(
    () => ownershipTimeline.clearIngestionCheckpoint(mismatchedCheckpoint),
    /Ingestion Checkpoint Cluster does not belong to its Workspace/,
  );
  assert.equal((await ownershipTimeline.getIngestionCheckpoint(savedScope.workspaceId, savedScope.clusterId, "Pod", "tracegarden"))?.resourceVersion, "1");
  await ownershipTimeline.clearIngestionCheckpoint(validCheckpoint);
  assert.equal(await ownershipTimeline.getIngestionCheckpoint(savedScope.workspaceId, savedScope.clusterId, "Pod", "tracegarden"), null);
}
const eventScope = savedScope ? { ...savedScope, resourceKinds: ["Event"] } : null;
const modernEvent = eventScope ? normalizeObservation(eventScope, {
  kind: "Event",
  metadata: { name: "modern-event", namespace: "tracegarden", uid: "event-uid-modern", resourceVersion: "1" },
  regarding: { apiVersion: "v1", kind: "Pod", name: "api", namespace: "tracegarden", uid: "pod-uid-1" },
  type: "Warning",
  reason: "FailedScheduling",
  note: "the scheduler could not place the Pod",
  eventTime: "2026-01-01T00:00:00.000Z",
  series: { count: 3, lastObservedTime: "2026-01-01T00:00:02.000Z" },
}, "2026-01-01T00:00:02.000Z") : null;
assert.equal(modernEvent?.message, "the scheduler could not place the Pod");
assert.equal(modernEvent?.count, 3);
assert.equal(modernEvent?.involvedKind, "Pod");
assert.equal(modernEvent?.involvedUid, "pod-uid-1");
assert.equal(modernEvent?.firstTimestamp, "2026-01-01T00:00:00.000Z");
assert.equal(modernEvent?.lastTimestamp, "2026-01-01T00:00:02.000Z");
assert.equal(modernEvent?.reason, "FailedScheduling");
assert.equal(modernEvent?.attentionReason, "event_warning");
const legacyEvent = eventScope ? normalizeObservation(eventScope, {
  kind: "Event",
  metadata: { name: "legacy-event", namespace: "tracegarden", uid: "event-uid-legacy", resourceVersion: "1" },
  involvedObject: { kind: "Deployment", name: "api", namespace: "tracegarden", uid: "deployment-uid" },
  type: "Normal",
  reason: "ScalingReplicaSet",
  message: "scaled",
  count: 2,
  firstTimestamp: "2026-01-01T00:00:01.000Z",
  lastTimestamp: "2026-01-01T00:00:03.000Z",
}, "2026-01-01T00:00:03.000Z") : null;
assert.equal(legacyEvent?.message, "scaled");
assert.equal(legacyEvent?.count, 2);
assert.equal(legacyEvent?.involvedKind, "Deployment");
assert.equal(legacyEvent?.lastTimestamp, "2026-01-01T00:00:03.000Z");
const invalidNumbers = savedScope ? normalizeObservation(savedScope, {
  kind: "Deployment",
  metadata: { name: "invalid-numbers", namespace: "tracegarden", uid: "invalid-numbers" },
  spec: { replicas: -1 },
  status: { availableReplicas: 1.5, readyReplicas: "9007199254740992" },
}, "2026-01-01T00:00:00.000Z") : null;
assert.equal(invalidNumbers?.desiredReplicas, null);
assert.equal(invalidNumbers?.availableReplicas, null);
assert.equal(invalidNumbers?.readyReplicas, null);
const upstreamCondition = savedScope ? normalizeObservation(savedScope, {
  kind: "Deployment",
  metadata: { name: "upstream-condition", namespace: "tracegarden", uid: "upstream-condition" },
  spec: { replicas: 2 },
  status: { availableReplicas: 1, reason: "ProgressDeadlineExceeded", message: "deployment did not progress" },
}, "2026-01-01T00:00:00.000Z") : null;
assert.equal(upstreamCondition?.attentionReason, "deployment_replicas_unavailable");
assert.equal(upstreamCondition?.reason, "ProgressDeadlineExceeded");
assert.equal(upstreamCondition?.message, "deployment did not progress");
const deploymentConditionOrders = [
  [
    { type: "Available", status: "True" },
    { type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" },
  ],
  [
    { type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" },
    { type: "Available", status: "True" },
  ],
];
for (const [index, conditions] of deploymentConditionOrders.entries()) {
  const deployment = savedScope ? normalizeObservation(savedScope, {
    kind: "Deployment",
    metadata: { name: `condition-order-${index}`, namespace: "tracegarden", uid: `condition-order-${index}` },
    spec: { replicas: 2 },
    status: { availableReplicas: 2, conditions },
  }, "2026-01-01T00:00:00.000Z") : null;
  assert.equal(deployment?.attention, true);
  assert.equal(deployment?.classification, "attention");
  assert.equal(deployment?.attentionReason, "condition_failed");
}

// Each supported family gets one behavior partition: meaningful change, attention, then recovery.
const familyFixtures = [
  ["Deployment", { spec: { replicas: 2 }, status: { availableReplicas: 2, readyReplicas: 2 } }, { spec: { replicas: 2 }, status: { availableReplicas: 1, readyReplicas: 1 } }, { spec: { replicas: 2 }, status: { availableReplicas: 2, readyReplicas: 2 } }],
  ["StatefulSet", { spec: { replicas: 2 }, status: { readyReplicas: 2, currentRevision: "r1", updateRevision: "r1" } }, { spec: { replicas: 2 }, status: { readyReplicas: 1, currentRevision: "r1", updateRevision: "r2" } }, { spec: { replicas: 2 }, status: { readyReplicas: 2, currentRevision: "r2", updateRevision: "r2" } }],
  ["DaemonSet", { status: { desiredNumberScheduled: 2, numberReady: 2, numberAvailable: 2 } }, { status: { desiredNumberScheduled: 2, numberReady: 1, numberAvailable: 1 } }, { status: { desiredNumberScheduled: 2, numberReady: 2, numberAvailable: 2 } }],
  ["ReplicaSet", { spec: { replicas: 2 }, status: { replicas: 2, readyReplicas: 2, availableReplicas: 2 } }, { spec: { replicas: 2 }, status: { replicas: 2, readyReplicas: 1, availableReplicas: 1 } }, { spec: { replicas: 2 }, status: { replicas: 2, readyReplicas: 2, availableReplicas: 2 } }],
  ["Pod", { status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } }, { status: { phase: "Pending", conditions: [{ type: "Ready", status: "False", reason: "ContainerCreating" }] } }, { status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } }],
  ["Job", { spec: { completions: 1 }, status: { succeeded: 1, failed: 0 } }, { spec: { completions: 1 }, status: { succeeded: 0, failed: 1, reason: "BackoffLimitExceeded" } }, { spec: { completions: 1 }, status: { succeeded: 1, failed: 0 } }],
  ["CronJob", { spec: { schedule: "* * * * *", suspend: false }, status: {} }, { spec: { schedule: "* * * * *", suspend: true }, status: {} }, { spec: { schedule: "* * * * *", suspend: false }, status: {} }],
  ["Event", { type: "Normal", reason: "Scheduled", message: "scheduled" }, { type: "Warning", reason: "FailedScheduling", message: "unschedulable" }, { type: "Normal", reason: "Scheduled", message: "scheduled" }],
];
const familyTimeline = new MemoryObservationStore();
const familyScope = { ...savedScope, resourceKinds: ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Pod", "Job", "CronJob", "Event"] };
for (const [kind, normal, abnormal, recovery] of familyFixtures) {
  const resources = [normal, abnormal, recovery].map((state, index) => ({
    kind,
    metadata: {
      name: `${kind.toLowerCase()}-sample`, namespace: "tracegarden", uid: `${kind}-uid`, resourceVersion: String(index + 1),
      ownerReferences: [{ kind: "Deployment", name: "owner", uid: "owner-uid", controller: true }],
      labels: { "app.kubernetes.io/name": "sample", "controller-revision-hash": `revision-${index + 1}` },
    },
    ...(kind === "Event" ? { involvedObject: { kind: "Pod", name: "sample-pod", namespace: "tracegarden", uid: "pod-uid" } } : {}),
    ...state,
  }));
  const normalized = resources.map((resource) => normalizeObservation(familyScope, resource, `2026-01-01T00:00:0${Number(resource.metadata.resourceVersion)}.000Z`));
  assert.equal(normalized[0]?.kind, kind);
  assert.equal(normalized[0]?.classification, "change");
  assert.equal(normalized[1]?.attention, true);
  assert.equal(normalized[1]?.classification, "attention");
  assert.equal(normalized[2]?.attention, false);
  assert.equal(normalized[0]?.ownerReferences[0]?.name, "owner");
  assert.match(normalized[0]?.revision ?? "", /revision-1|r1/);
  const persisted = await familyTimeline.recordObservations(normalized);
  assert.deepEqual(persisted.map(({ observation }) => observation.classification), ["change", "attention", "recovery"]);
  assert.equal(persisted[2]?.entry.recoveryOf, persisted[1]?.observation.sourceKey);
}
assert.equal(await familyTimeline.countObservations("workspace-single"), familyFixtures.length * 3);
const equalTimeResources = [
  { kind: "Pod", metadata: { name: "equal-time", namespace: "tracegarden", uid: "equal-time-uid", resourceVersion: "1" }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } },
  { kind: "Pod", metadata: { name: "equal-time", namespace: "tracegarden", uid: "equal-time-uid", resourceVersion: "2" }, status: { phase: "Pending", conditions: [{ type: "Ready", status: "False" }] } },
  { kind: "Pod", metadata: { name: "equal-time", namespace: "tracegarden", uid: "equal-time-uid", resourceVersion: "3" }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } },
].map((resource) => normalizeObservation(familyScope, resource, "2026-01-01T00:00:00.000Z"));
const equalTimePersisted = await new MemoryObservationStore().recordObservations(equalTimeResources);
assert.deepEqual(equalTimePersisted.map(({ observation }) => observation.classification), ["change", "attention", "recovery"]);
assert.equal(equalTimePersisted[2]?.entry.recoveryOf, equalTimePersisted[1]?.observation.sourceKey);
if (ownerAdmission.admitted && savedScope) {
  const familyEntries = (await familyTimeline.listTimelineEntries("workspace-single", { limit: 100 })).entries;
  const zhFamilyPage = renderApplicationPage("zh-CN", ownerAdmission.session, savedScope, undefined, familyEntries);
  assert.match(zhFamilyPage, /待关注项/);
  assert.match(zhFamilyPage, /副本不可用/);
  assert.doesNotMatch(zhFamilyPage, /deployment_replicas_unavailable/);
  assert.match(renderApplicationPage("en", ownerAdmission.session, savedScope, undefined, familyEntries), /Attention Item/);
  assert.match(renderApplicationPage("en", ownerAdmission.session, savedScope, undefined, familyEntries), /Recovery/);
  const failedConditionJob = await new MemoryObservationStore().recordObservation(normalizeObservation(familyScope, {
    kind: "Job",
    metadata: { name: "failed-condition-job", namespace: "tracegarden", uid: "failed-condition-job-uid", resourceVersion: "1" },
    spec: { completions: 1 },
    status: { conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded" }] },
  }, "2026-01-01T00:00:01.000Z"));
  assert.equal(failedConditionJob.observation.failed, null);
  assert.equal(failedConditionJob.observation.classification, "attention");
  const failedConditionJobPage = renderApplicationPage("en", ownerAdmission.session, savedScope, undefined, [failedConditionJob.entry]);
  assert.match(failedConditionJobPage, /Job · Attention Item/);
  assert.match(failedConditionJobPage, /Attention Item/);
  const completedJob = await new MemoryObservationStore().recordObservation(normalizeObservation(familyScope, {
    kind: "Job",
    metadata: { name: "completed-job", namespace: "tracegarden", uid: "completed-job-uid", resourceVersion: "1" },
    spec: { completions: 1 },
    status: { succeeded: 1, failed: 1, completionTime: "2026-01-01T00:00:00.000Z" },
  }, "2026-01-01T00:00:01.000Z"));
  const completedJobPage = renderApplicationPage("en", ownerAdmission.session, savedScope, undefined, [completedJob.entry]);
  assert.match(completedJobPage, /2026-01-01T00:00:00.000Z/);
  assert.doesNotMatch(completedJobPage, />Recovery<\/h3>/);
  assert.doesNotMatch(completedJobPage, /Attention Item/);
}
const liveTimeline = new MemoryObservationStore();
const liveHints = [];
const unsubscribeLiveTimeline = await liveTimeline.subscribeTimeline((hint) => liveHints.push(hint));
assert.deepEqual(parseTimelineNotification(JSON.stringify({ entryId: "entry-1" })), { entryId: "entry-1" });
assert.equal(parseTimelineNotification(JSON.stringify({ entryId: "entry-1", content: "must not cross the hint boundary" })), null);
const liveObservation = savedScope ? normalizePodObservation(savedScope, {
  kind: "Pod",
  metadata: { name: "live-entry", namespace: "tracegarden", uid: "live-entry-uid", resourceVersion: "1" },
  status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
}, "2099-01-01T00:00:00.000Z") : null;
if (liveObservation) {
  const liveResult = await liveTimeline.recordObservation(liveObservation);
  assert.deepEqual(liveHints, [{ entryId: liveResult.entry.id }]);
  const livePage = await liveTimeline.listTimelineEntries("workspace-single", { limit: 1 }, ownerActor.id);
  assert.equal(livePage.resumeCursor !== undefined, true);
  if (livePage.resumeCursor) {
    const [encodedPayload] = livePage.resumeCursor.split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    assert.equal(payload.version, 2);
    assert.equal(payload.sequence, liveResult.entry.timelineSequence);
  }
  const sequenceTimeline = new MemoryObservationStore();
  const sequenceObservations = [
    normalizePodObservation(savedScope, {
      kind: "Pod",
      metadata: { name: "newer-source-time", namespace: "tracegarden", uid: "sequence-newer", resourceVersion: "1" },
      status: { phase: "Running" },
    }, "2099-01-02T00:00:00.000Z"),
    normalizePodObservation(savedScope, {
      kind: "Pod",
      metadata: { name: "older-source-time", namespace: "tracegarden", uid: "sequence-older", resourceVersion: "1" },
      status: { phase: "Running" },
    }, "2000-01-01T00:00:00.000Z"),
  ];
  const sequenceResults = await sequenceTimeline.recordObservations(sequenceObservations);
  assert.deepEqual((await sequenceTimeline.listTimelineEntries("workspace-single", { limit: 100 })).entries.map((entry) => entry.observation.name), ["newer-source-time", "older-source-time"]);
  const sequenceFirstPage = await sequenceTimeline.listTimelineEntries("workspace-single", { limit: 1 }, ownerActor.id);
  assert.equal(sequenceFirstPage.entries[0]?.id, sequenceResults[0]?.entry.id);
  const sequenceSecondPage = await sequenceTimeline.listTimelineEntries("workspace-single", { limit: 1, cursor: sequenceFirstPage.nextCursor ?? "" }, ownerActor.id);
  assert.equal(sequenceSecondPage.entries[0]?.id, sequenceResults[1]?.entry.id);
}
unsubscribeLiveTimeline();
const backpressureRuntime = await createWebRuntime({
  database: new MemoryDatabase(),
  identityAdapter: new LocalIdentityAdapter(),
  environment: { NODE_ENV: "test", HOST: "127.0.0.1" },
  port: 43209,
});
const originalResponseWrite = ServerResponse.prototype.write;
let forceBackpressure = false;
let backpressureWriteObserved = false;
ServerResponse.prototype.write = function (...args) {
  if (forceBackpressure) {
    backpressureWriteObserved = true;
    return false;
  }
  return originalResponseWrite.apply(this, args);
};
try {
  const backpressureLogin = await fetch("http://127.0.0.1:43209/auth/login", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "identity=owner&lang=en",
  });
  forceBackpressure = true;
  const backpressureStream = await fetch("http://127.0.0.1:43209/api/timeline/stream", {
    headers: { cookie: backpressureLogin.headers.get("set-cookie") ?? "" },
  });
  assert.equal(backpressureStream.status, 200);
  await backpressureStream.body.cancel();
  assert.equal(backpressureWriteObserved, true);
} finally {
  forceBackpressure = false;
  ServerResponse.prototype.write = originalResponseWrite;
  await backpressureRuntime.close();
}
const memoryTimeline = new MemoryObservationStore();
const experimentInput = {
  hypothesis: "**markdown hypothesis**",
  change: "scale the workload",
  observation: "the Pod recovered",
  conclusion: "",
  state: "active",
  tags: ["recovery", "markdown"],
  workloads: [{ clusterId: "lab-cluster", namespace: "tracegarden", kind: "Deployment", name: "api" }],
  gitRevision: "abc123",
};
assert.equal(parseExperimentInput(experimentInput).hypothesis, "**markdown hypothesis**");
assert.throws(
  () => parseExperimentInput({ ...experimentInput, workloads: [{ clusterId: "lab cluster", namespace: "tracegarden", kind: "Deployment", name: "api" }] }),
  (error) => error instanceof ExperimentValidationError && error.issues.some(({ field }) => field === "workloads"),
);
assert.throws(
  () => parseExperimentInput({ ...experimentInput, gitRevision: "not a git revision" }),
  (error) => error instanceof ExperimentValidationError && error.issues.some(({ field }) => field === "gitRevision"),
);
assert.equal(hasExperimentWrite(ownerMember ?? { capabilities: [] }), true);
if (ownerMember) {
  const scopedExperimentTimeline = new MemoryObservationStore(scopeStore);
  await assert.rejects(
    () => scopedExperimentTimeline.createExperiment(ownerMember.workspaceId, ownerMember.id, {
      ...experimentInput,
      workloads: [{ ...experimentInput.workloads[0], clusterId: "unknown-cluster" }],
    }),
    (error) => error instanceof ExperimentValidationError && error.issues.some(({ field }) => field === "workloads"),
  );
  await assert.rejects(
    () => scopedExperimentTimeline.createExperiment("workspace-other", ownerMember.id, experimentInput),
    (error) => error instanceof ExperimentValidationError && error.issues.some(({ field }) => field === "workloads"),
  );
  const experimentTimeline = new MemoryObservationStore();
  const memoryExperiment = await createExperiment(ownerMember, experimentTimeline, experimentInput);
  assert.equal(memoryExperiment.workspaceId, "workspace-single");
  const memoryExperimentUpdate = await experimentTimeline.updateExperiment(ownerMember.workspaceId, memoryExperiment.id, { conclusion: "verified", state: "concluded", tags: ["verified"] });
  assert.equal(memoryExperimentUpdate?.id, memoryExperiment.id);
  assert.equal(memoryExperimentUpdate?.timelineEntryId, memoryExperiment.timelineEntryId);
  assert.deepEqual(memoryExperimentUpdate?.workloads, memoryExperiment.workloads);
  await assert.rejects(() => experimentTimeline.updateExperiment(ownerMember.workspaceId, memoryExperiment.id, { state: "active" }), (error) => error instanceof ExperimentLifecycleError);
}
const collectorWithPersistence = await createCollectorRuntime({ port: 43203, host: "127.0.0.1", scope: savedScope ?? undefined, adapter: deterministic, observationStore: memoryTimeline });
try {
  const firstPersist = await collectorWithPersistence.collectObservations();
  assert.equal(firstPersist.length, 1);
  assert.equal(firstPersist[0]?.duplicate, false);
  assert.equal(firstPersist[0]?.entry.workspaceId, "workspace-single");
  assert.equal(firstPersist[0]?.entry.clusterId, "lab-cluster");
  assert.doesNotMatch(JSON.stringify(firstPersist[0]), /conditions/);
  const duplicatePersist = await collectorWithPersistence.collectObservations();
  assert.equal(duplicatePersist[0]?.duplicate, true);
  assert.equal(await memoryTimeline.countObservations("workspace-single"), 1);
  assert.equal(await memoryTimeline.countTimelineEntries("workspace-single"), 1);
  const duplicateAttentionObservation = savedScope ? normalizePodObservation(savedScope, {
    kind: "Pod",
    metadata: { name: "in-scope", namespace: "tracegarden", uid: "pod-uid-1", resourceVersion: "1" },
    status: { phase: "Pending", conditions: [{ type: "Ready", status: "False" }] },
  }, "2099-01-01T00:00:00.000Z") : null;
  const duplicateAttentionResult = duplicateAttentionObservation ? await memoryTimeline.recordObservation(duplicateAttentionObservation) : null;
  assert.equal(duplicateAttentionResult?.duplicate, true);
  assert.equal(duplicateAttentionResult?.entry.attention, false);
  const attentionObservation = savedScope ? normalizePodObservation(savedScope, {
    kind: "Pod",
    metadata: { name: "pending-review", namespace: "tracegarden", uid: "pod-uid-review", resourceVersion: "2" },
    status: { phase: "Pending", conditions: [{ type: "Ready", status: "False" }] },
  }, "2099-01-01T00:00:00.000Z") : null;
  const attentionResult = attentionObservation ? await memoryTimeline.recordObservation(attentionObservation) : null;
  assert.equal(attentionResult?.entry.attention, true);
  const memoryMemberlessPage = await memoryTimeline.listTimelineEntries("workspace-single", { limit: 100 });
  assert.ok(memoryMemberlessPage.entries.some(({ attention }) => attention));
  assert.ok(memoryMemberlessPage.entries.every(({ attentionUnread }) => !attentionUnread));
  const memoryPage = await memoryTimeline.listTimelineEntries("workspace-single", { limit: 1 }, ownerActor.id);
  assert.ok(memoryPage.nextCursor);
  const memoryNextPage = await memoryTimeline.listTimelineEntries("workspace-single", { limit: 1, cursor: memoryPage.nextCursor }, ownerActor.id);
  assert.equal(memoryNextPage.entries[0]?.observation.name, "pending-review");
  if (memoryPage.nextCursor) {
    const [encodedPayload, encodedSignature] = memoryPage.nextCursor.split(".");
    assert.ok(encodedPayload && encodedSignature);
    const alteredPayload = `${encodedPayload.slice(0, -1)}${encodedPayload.endsWith("A") ? "B" : "A"}`;
    await assert.rejects(
      memoryTimeline.listTimelineEntries("workspace-single", { limit: 1, cursor: `${alteredPayload}.${encodedSignature}` }, ownerActor.id),
      (error) => error instanceof TimelineQueryValidationError,
    );
    const alteredSignature = `${encodedSignature.slice(0, -1)}${encodedSignature.endsWith("A") ? "B" : "A"}`;
    await assert.rejects(
      memoryTimeline.listTimelineEntries("workspace-single", { limit: 1, cursor: `${encodedPayload}.${alteredSignature}` }, ownerActor.id),
      (error) => error instanceof TimelineQueryValidationError,
    );
    await assert.rejects(
      memoryTimeline.listTimelineEntries("workspace-single", { limit: 1, cursor: memoryPage.nextCursor, namespace: "other" }, ownerActor.id),
      (error) => error instanceof TimelineQueryValidationError,
    );
    if (invitedAdmission.admitted) {
      await assert.rejects(
        memoryTimeline.listTimelineEntries("workspace-single", { limit: 1, cursor: memoryPage.nextCursor }, invitedAdmission.session.member.id),
        (error) => error instanceof TimelineQueryValidationError,
      );
    }
  }
  assert.equal(memoryNextPage.unreadAttentionCount, 1);
  if (attentionResult) {
    assert.deepEqual(await memoryTimeline.reviewAttentionItem("workspace-single", ownerActor.id, attentionResult.entry.id), { entryId: attentionResult.entry.id, reviewed: true, unreadCount: 0 });
    assert.deepEqual(await memoryTimeline.reviewAttentionItem("workspace-single", ownerActor.id, attentionResult.entry.id), { entryId: attentionResult.entry.id, reviewed: false, unreadCount: 0 });
  }
} finally {
  await collectorWithPersistence.close();
}
const exporterCollectorRuntime = await createCollectorRuntime({
  port: 43216,
  host: "127.0.0.1",
  scope: savedScope ?? undefined,
  adapter: deterministic,
  observationStore: new MemoryObservationStore(),
  telemetry: exporterFailureTelemetry,
});
try {
  await exporterCollectorRuntime.collectObservations();
  const collectorReadyHealth = await fetch("http://127.0.0.1:43216/health/readiness");
  assert.equal(collectorReadyHealth.status, 200);
  const collectorReadyBody = await collectorReadyHealth.json();
  assert.deepEqual({ startup: collectorReadyBody.startup, readiness: collectorReadyBody.readiness, liveness: collectorReadyBody.liveness }, { startup: "ready", readiness: "ready", liveness: "alive" });
  const collectorLiveHealth = await fetch("http://127.0.0.1:43216/health/live");
  assert.equal(collectorLiveHealth.status, 200);
  const collectorMetrics = await fetch("http://127.0.0.1:43216/metrics");
  const collectorMetricsBody = await collectorMetrics.text();
  assert.match(collectorMetricsBody, /tracegarden_collector_lag_seconds/);
  assert.match(collectorMetricsBody, /tracegarden_collector_reconnects_total/);
  assert.match(collectorMetricsBody, /tracegarden_database_pool_waiting/);
  assert.match(collectorMetricsBody, /tracegarden_migration_status/);
} finally {
  await exporterCollectorRuntime.close();
}
let scheduledRetentionCleanup;
let retentionCleanupCalls = 0;
let retentionCleanupCancelled = false;
const injectedRetentionStore = {
  getRetentionPolicy: async () => ({ workspaceId: "workspace-single", retentionDays: 90, updatedAt: "2026-01-01T00:00:00.000Z" }),
  updateRetentionPolicy: async (_workspaceId, retentionDays) => ({ workspaceId: "workspace-single", retentionDays: Number(retentionDays), updatedAt: "2026-01-01T00:00:00.000Z" }),
  cleanupRetention: async () => {
    retentionCleanupCalls += 1;
    return { workspaceId: "workspace-single", retentionDays: 90, cutoff: "", eligibleObservations: 0, protectedObservations: 0, deletedObservations: 0, deletedTimelineEntries: 0, failures: 0, failureCount: 0, retryable: true };
  },
};
const scheduledCollector = await createCollectorRuntime({
  port: 43214,
  host: "127.0.0.1",
  scope: savedScope ?? undefined,
  adapter: deterministic,
  observationStore: new MemoryObservationStore(),
  retentionStore: injectedRetentionStore,
  retentionCleanupIntervalMs: 123,
  retentionCleanupScheduler: (task, intervalMs) => {
    assert.equal(intervalMs, 123);
    scheduledRetentionCleanup = task;
    return () => { retentionCleanupCancelled = true; };
  },
});
try {
  assert.ok(scheduledRetentionCleanup);
  scheduledRetentionCleanup();
  assert.equal(retentionCleanupCalls, 1);
} finally {
  await scheduledCollector.close();
}
assert.equal(retentionCleanupCancelled, true);
scheduledRetentionCleanup();
assert.equal(retentionCleanupCalls, 1);
await assert.rejects(
  createCollectorRuntime({ environment: { NODE_ENV: "production" }, adapter: deterministic, database: {} }),
  /Production collector stores must be database-owned/,
);
await assert.rejects(
  createCollectorRuntime({ environment: { NODE_ENV: "production" }, adapter: deterministic, observationStore: new MemoryObservationStore() }),
  /Production collector stores must be database-owned/,
);
await assert.rejects(
  createCollectorRuntime({ environment: { NODE_ENV: "production" }, adapter: deterministic, retentionStore: injectedRetentionStore }),
  /Production collector stores must be database-owned/,
);
class FailingObservationStore extends MemoryObservationStore {
  async recordObservation() {
    throw new Error("database write failed");
  }

  async recordObservations() {
    throw new Error("database write failed");
  }
}
const failedCollection = await createCollectorRuntime({ port: 43207, host: "127.0.0.1", scope: savedScope ?? undefined, adapter: deterministic, observationStore: new FailingObservationStore() });
try {
  await assert.rejects(failedCollection.collectObservations(), (error) => error instanceof CollectorRecoveryError && /persistence failed/.test(error.message));
  const failedCollectorReadiness = await fetch("http://127.0.0.1:43207/health/readiness");
  assert.equal(failedCollectorReadiness.status, 503);
  const completedCollectorStartup = await fetch("http://127.0.0.1:43207/health/startup");
  assert.equal(completedCollectorStartup.status, 200);
  assert.equal((await completedCollectorStartup.json()).startup, "ready");
  const failedCollectorLiveness = await fetch("http://127.0.0.1:43207/health/live");
  assert.equal(failedCollectorLiveness.status, 200);
} finally {
  await failedCollection.close();
}
let releaseInitialList;
const initialListBlocked = new Promise((resolve) => { releaseInitialList = resolve; });
let initialListStarted = false;
const startupAdapter = {
  kind: "deterministic",
  contacted: false,
  list: async () => {
    initialListStarted = true;
    await initialListBlocked;
    return [];
  },
};
const startup = createCollectorRuntime({ port: 43212, host: "127.0.0.1", scope: savedScope ?? undefined, adapter: startupAdapter, observationStore: new MemoryObservationStore(), collectOnStart: true });
while (!initialListStarted) await Promise.resolve();
await assert.rejects(fetch("http://127.0.0.1:43212/health/readiness"));
releaseInitialList();
const startedRuntime = await startup;
try {
  assert.equal(startedRuntime.status().checks.collector, "ready");
} finally {
  await startedRuntime.close();
}
const startupFailureStore = new FailingObservationStore();
await assert.rejects(
  createCollectorRuntime({ port: 43213, host: "127.0.0.1", scope: savedScope ?? undefined, adapter: deterministic, observationStore: startupFailureStore, collectOnStart: true }),
  (error) => error instanceof CollectorRecoveryError,
);
assert.equal(await startupFailureStore.countObservations("workspace-single"), 0);
await assert.rejects(fetch("http://127.0.0.1:43213/health/readiness"));
const viewerMember = ownerMember ? { ...ownerMember, role: "viewer", capabilities: [capabilities.workspaceRead, capabilities.timelineRead] } : null;
if (viewerMember) await assert.rejects(configureClusterScope(viewerMember, scopeStore, scopeInput), /cluster:configure/);
assert.equal(productionKubernetesConfiguration({ NODE_ENV: "production" }), null);
assert.equal(productionKubernetesLogConfiguration({
  NODE_ENV: "production",
  KUBERNETES_API_SERVER: "https://observation.example.test",
  KUBERNETES_OBSERVATION_TOKEN: "observation-token",
}), null);
assert.equal(productionKubernetesLogConfiguration({
  NODE_ENV: "production",
  KUBERNETES_LOG_API_SERVER: "https://logs.example.test",
  KUBERNETES_LOG_TOKEN: "observation-token",
  KUBERNETES_OBSERVATION_TOKEN: "observation-token",
}), null);
const logConfiguration = productionKubernetesLogConfiguration({
  NODE_ENV: "production",
  KUBERNETES_LOG_API_SERVER: "https://logs.example.test",
  KUBERNETES_LOG_TOKEN: "logs-token",
});
assert.equal(logConfiguration?.identity, "logs-reader");
assert.equal(logConfiguration?.endpoint, "https://logs.example.test");
assert.equal(logConfiguration?.token, "logs-token");
assert.ok(logConfiguration);
assert.equal(new ConfiguredKubernetesLogAdapter(logConfiguration).contacted, false);
const streamedLogText = "first\r\n🙂\r\nlast\r\n";
const streamedLogBytes = new TextEncoder().encode(streamedLogText);
const emojiCut = new TextEncoder().encode("first\r\n🙂").length - 1;
const configuredLogAdapter = new ConfiguredKubernetesLogAdapter(logConfiguration, async (url, init) => {
  assert.match(String(url), /api\/v1\/namespaces\/tracegarden\/pods\/api-0\/log/);
  assert.match(String(url), /container=app/);
  assert.match(String(url), /tailLines=2/);
  assert.equal(init?.headers?.authorization, "Bearer logs-token");
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(streamedLogBytes.slice(0, emojiCut));
      controller.enqueue(streamedLogBytes.slice(emojiCut, emojiCut + 1));
      controller.enqueue(streamedLogBytes.slice(emojiCut + 1));
      controller.close();
    },
  }), { status: 200 });
});
assert.equal(await configuredLogAdapter.read({ clusterId: "lab-cluster", namespace: "tracegarden", pod: "api-0", container: "app", tail: 2 }), streamedLogText);
const utf8Bound = boundRecentLogWindow([`prefix-${"🙂".repeat(LOG_MAX_BYTES)}`], 1);
assert.ok(utf8Bound.byteCount <= LOG_MAX_BYTES);
assert.doesNotMatch(utf8Bound.body, /�/);
const inertAdapter = createKubernetesAdapter({ NODE_ENV: "production" });
assert.equal(inertAdapter.kind, "inert");
assert.equal(inertAdapter.contacted, false);
if (savedScope) assert.deepEqual(await collectScopedResources(savedScope, inertAdapter), []);
const configuredAdapter = new ConfiguredKubernetesAdapter({ endpoint: "https://cluster.example.test/environment", token: "local-test-token" });
assert.equal(configuredAdapter.contacted, false);
assert.equal(configuredAdapter.configuration.endpoint, "https://cluster.example.test/environment");
assert.equal(compareResourceVersions("9007199254740993", "9007199254740992"), 1);
assert.equal(compareResourceVersions("9007199254740992", "9007199254740993"), -1);
assert.equal(compareResourceVersions("opaque-new", "opaque-old"), 0);
const configuredScope = savedScope ? { ...savedScope, endpoint: "https://cluster.example.test/persisted", namespaces: ["tracegarden"], resourceKinds: ["Pod"] } : null;

const logScope = savedScope ?? {
  workspaceId: "workspace-single",
  clusterId: "lab-cluster",
  name: "Personal lab",
  endpoint: "https://cluster.example.test",
  namespaces: ["tracegarden"],
  resourceKinds: ["Pod"],
};
const logLines = Array.from({ length: LOG_MAX_LINES + 25 }, (_, index) => `protected-log-${index}`);
const logAdapter = new FakeKubernetesLogAdapter([{
  clusterId: logScope.clusterId,
  namespace: "tracegarden",
  pod: "api-0",
  container: "app",
  tail: LOG_MAX_LINES,
  lines: logLines,
}]);
const telemetryEvents = [];
const recentLogs = await requestRecentLogWindow({
  member: ownerMember,
  scope: logScope,
  input: { clusterId: logScope.clusterId, namespace: "tracegarden", pod: "api-0", container: "app", tail: LOG_MAX_LINES },
  adapter: logAdapter,
  auditStore: admissionStore,
  telemetry: {
    structuredLog: (event) => telemetryEvents.push(event),
    trace: (event) => telemetryEvents.push(event),
    metric: (event) => telemetryEvents.push(event),
    analytics: (event) => telemetryEvents.push(event),
  },
});
assert.equal(recentLogs.lineCount, LOG_MAX_LINES);
assert.equal(recentLogs.byteCount, new TextEncoder().encode(recentLogs.body).length);
assert.match(recentLogs.body, /protected-log-124/);
assert.doesNotMatch(JSON.stringify(await admissionStore.listAuditRecords()), /protected-log-/);
assert.doesNotMatch(JSON.stringify(telemetryEvents), /protected-log-/);
assert.equal(logAdapter.requests.length, 1);
assert.equal(validateRecentLogWindowInput({ ...scopeInput, clusterId: logScope.clusterId, namespace: "tracegarden", pod: "api-0", container: "app", tail: LOG_MAX_LINES + 1 }).valid, false);
await assert.rejects(() => requestRecentLogWindow({
  member: viewerMember,
  scope: logScope,
  input: { clusterId: logScope.clusterId, namespace: "tracegarden", pod: "api-0", container: "app", tail: 1 },
  adapter: logAdapter,
}), /logs:read/);
assert.equal(logAdapter.requests.length, 1);
const byteBound = boundRecentLogWindow(["protected-log-".repeat(LOG_MAX_BYTES)], 1);
assert.equal(byteBound.byteCount, LOG_MAX_BYTES);
assert.ok(byteBound.lineCount <= LOG_MAX_LINES);
const failingLogAdapter = {
  kind: "fake",
  contacted: false,
  read: async () => { throw new Error("protected-log-body"); },
};
await assert.rejects(() => requestRecentLogWindow({
  member: ownerMember,
  scope: logScope,
  input: { clusterId: logScope.clusterId, namespace: "tracegarden", pod: "api-0", container: "app", tail: 1 },
  adapter: failingLogAdapter,
}), (error) => error instanceof Error && error.message === "Recent Log Window is unavailable" && !error.message.includes("protected-log-body"));
const failingAuditStore = {
  recordLogAccess: async () => { throw new Error("protected-log-audit-body"); },
};
await assert.rejects(() => requestRecentLogWindow({
  member: ownerMember,
  scope: logScope,
  input: { clusterId: logScope.clusterId, namespace: "tracegarden", pod: "api-0", container: "app", tail: 1 },
  adapter: logAdapter,
  auditStore: failingAuditStore,
}), (error) => error instanceof Error && error.message === "Recent Log Window audit is unavailable" && !error.message.includes("protected-log-audit-body"));
const telemetrySafeLog = await requestRecentLogWindow({
  member: ownerMember,
  scope: logScope,
  input: { clusterId: logScope.clusterId, namespace: "tracegarden", pod: "api-0", container: "app", tail: 1 },
  adapter: logAdapter,
  telemetry: {
    structuredLog: () => { throw new Error("protected-log-structured"); },
    trace: () => { throw new Error("protected-log-trace"); },
    metric: () => { throw new Error("protected-log-metric"); },
    analytics: () => { throw new Error("protected-log-analytics"); },
  },
});
assert.match(telemetrySafeLog.body, /protected-log-224/);
const asyncTelemetryLog = await requestRecentLogWindow({
  member: ownerMember,
  scope: logScope,
  input: { clusterId: logScope.clusterId, namespace: "tracegarden", pod: "api-0", container: "app", tail: 1 },
  adapter: logAdapter,
  telemetry: {
    structuredLog: async () => { throw new Error("async structured exporter rejected"); },
    trace: async () => { throw new Error("async trace exporter rejected"); },
    metric: async () => { throw new Error("async metric exporter rejected"); },
    analytics: async () => { throw new Error("async analytics exporter rejected"); },
  },
});
assert.match(asyncTelemetryLog.body, /protected-log-224/);
await new Promise((resolve) => setImmediate(resolve));

const collector = collectorStatus();
assert.equal(collector.status, "not-ready");
assert.equal(collector.readiness, "not-ready");
assert.equal(collector.checks.collector, "not-ready");
assert.equal(collector.checks.clusterContacted, false);
const collectorRuntime = await createCollectorRuntime({ port: 43202, host: "127.0.0.1", scope: savedScope ?? undefined, adapter: deterministic });
try {
  assert.deepEqual((await collectorRuntime.collect()).map((resource) => resource.metadata.name), ["in-scope"]);
  const collectorResponse = await fetch("http://127.0.0.1:43202/health/readiness");
  assert.equal(collectorResponse.status, 200);
  const collectorReadiness = await collectorResponse.json();
  assert.equal(collectorReadiness.status, "ready");
  assert.equal(collectorReadiness.checks.clusterContacted, false);
} finally {
  await collectorRuntime.close();
}
const lostCollectorDatabase = new MemoryDatabase();
let lostCollectorDatabaseReady = true;
lostCollectorDatabase.ping = async () => lostCollectorDatabaseReady;
const lostCollectorRuntime = await createCollectorRuntime({
  port: 43219,
  host: "127.0.0.1",
  scope: savedScope ?? undefined,
  adapter: deterministic,
  database: lostCollectorDatabase,
});
try {
  lostCollectorDatabaseReady = false;
  const lostReadiness = await fetch("http://127.0.0.1:43219/health/readiness");
  assert.equal(lostReadiness.status, 503);
  const lostMetrics = await fetch("http://127.0.0.1:43219/metrics");
  assert.match(await lostMetrics.text(), /tracegarden_collector_database_ready 0/);
  lostCollectorDatabaseReady = true;
  assert.equal((await fetch("http://127.0.0.1:43219/health/readiness")).status, 200);
} finally {
  await lostCollectorRuntime.close();
}
const inertCollectorRuntime = await createCollectorRuntime({
  port: 43220,
  host: "127.0.0.1",
  scope: savedScope ?? undefined,
  adapter: createKubernetesAdapter({ NODE_ENV: "production" }),
  observationStore: new MemoryObservationStore(),
});
try {
  const inertReadiness = await fetch("http://127.0.0.1:43220/health/readiness");
  assert.equal(inertReadiness.status, 503);
  assert.equal((await inertReadiness.json()).checks.collector, "not-ready");
} finally {
  await inertCollectorRuntime.close();
}
const bindFailureCollectorTelemetry = createTelemetry({ serviceName: "tracegarden-collector-bind-test" });
const occupiedCollectorPort = 43222;
const occupiedCollectorRuntime = await createCollectorRuntime({
  port: occupiedCollectorPort,
  host: "127.0.0.1",
  scope: savedScope ?? undefined,
  adapter: deterministic,
  observationStore: new MemoryObservationStore(),
});
try {
  await assert.rejects(
    createCollectorRuntime({
      port: occupiedCollectorPort,
      host: "127.0.0.1",
      scope: savedScope ?? undefined,
      adapter: deterministic,
      observationStore: new MemoryObservationStore(),
      telemetry: bindFailureCollectorTelemetry,
    }),
    /EADDRINUSE/,
  );
  const collectorBindSignals = bindFailureCollectorTelemetry.signals();
  assert.ok(collectorBindSignals.some((signal) => signal.kind === "log" && signal.event === "collector.startup.failure"));
  assert.equal(collectorBindSignals.some((signal) => signal.kind === "log" && signal.event === "collector.started"), false);
} finally {
  await occupiedCollectorRuntime.close();
}

const scopeDatabase = new MemoryDatabase();
let transportLogReads = 0;
const transportLogAdapter = {
  kind: "fake",
  contacted: false,
  read: async () => {
    transportLogReads += 1;
    if (transportLogReads > 2) throw new Error("transport-protected-log-body");
    return ["transport-log-one", "transport-log-two"];
  },
};
const scopeRuntime = await createWebRuntime({
  database: scopeDatabase,
  logAdapter: transportLogAdapter,
  telemetry: exporterFailureTelemetry,
  environment: { NODE_ENV: "test", HOST: "127.0.0.1" },
  port: 43208,
});
try {
  const login = await fetch("http://127.0.0.1:43208/auth/login", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "identity=owner&lang=en",
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie") ?? "";
  const saved = await fetch("http://127.0.0.1:43208/api/cluster", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(scopeInput),
  });
  assert.equal(saved.status, 200);
  const savedPayload = await saved.json();
  assert.equal(savedPayload.scope.clusterId, "lab-cluster");
  const formSave = await fetch("http://127.0.0.1:43208/cluster/configure?lang=en", {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams([
      ["clusterId", "lab-cluster"],
      ["name", "Updated lab"],
      ["endpoint", "https://cluster.example.test"],
      ["namespaces", "tracegarden\ndefault"],
      ["resourceKinds", "Pod"],
      ["resourceKinds", "Deployment"],
    ]),
  });
  assert.equal(formSave.status, 303);
  const loaded = await fetch("http://127.0.0.1:43208/api/cluster", { headers: { cookie } });
  assert.equal((await loaded.json()).scope.name, "Updated lab");
  const recentLogResponse = await fetch("http://127.0.0.1:43208/api/logs/recent", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ clusterId: "lab-cluster", namespace: "tracegarden", pod: "api-0", container: "app", tail: 2 }),
  });
  assert.equal(recentLogResponse.status, 200);
  assert.equal(recentLogResponse.headers.get("cache-control"), "no-store");
  const recentLogPayload = await recentLogResponse.json();
  assert.equal(recentLogPayload.window.body, "transport-log-one\ntransport-log-two");
  const logAudit = await fetch("http://127.0.0.1:43208/api/audit", { headers: { cookie } });
  const logAuditPayload = await logAudit.json();
  assert.ok(logAuditPayload.records.some(({ action }) => action === "log.accessed"));
  assert.doesNotMatch(JSON.stringify(logAuditPayload), /transport-log-/);
  const recentLogForm = await fetch("http://127.0.0.1:43208/logs/recent?lang=zh-CN", {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ clusterId: "lab-cluster", namespace: "tracegarden", pod: "api-0", container: "app", tail: "2" }),
  });
  assert.equal(recentLogForm.status, 200);
  assert.equal(recentLogForm.headers.get("cache-control"), "no-store");
  assert.match(await recentLogForm.text(), /transport-log-one/);
  const failedRecentLog = await fetch("http://127.0.0.1:43208/api/logs/recent", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ clusterId: "lab-cluster", namespace: "tracegarden", pod: "api-0", container: "app", tail: 2 }),
  });
  assert.equal(failedRecentLog.status, 503);
  assert.equal(failedRecentLog.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await failedRecentLog.text(), /transport-protected-log-body/);
  const failedRecentLogForm = await fetch("http://127.0.0.1:43208/logs/recent?lang=en", {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ clusterId: "lab-cluster", namespace: "tracegarden", pod: "api-0", container: "app", tail: "2" }),
  });
  assert.equal(failedRecentLogForm.status, 503);
  assert.equal(failedRecentLogForm.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await failedRecentLogForm.text(), /transport-protected-log-body/);
  const protectedRequestBody = "protected-http-body";
  const protectedRequest = await fetch("http://127.0.0.1:43208/api/logs/recent", {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-request-id": "protected-request-correlation" },
    body: JSON.stringify({ clusterId: "lab-cluster", namespace: "tracegarden", pod: "api-0", container: "app", tail: 2, body: protectedRequestBody }),
  });
  assert.equal(protectedRequest.status, 503);
  assert.notEqual(protectedRequest.headers.get("x-request-id"), "protected-request-correlation");
  assert.doesNotMatch(JSON.stringify(exporterFailureTelemetry.signals()), /protected-http-body|protected-request-correlation/);
  assert.doesNotMatch(JSON.stringify(exporterFailureTelemetry.signals()), /transport-log-/);
  const invalidRecentLog = await fetch("http://127.0.0.1:43208/api/logs/recent", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ clusterId: "lab-cluster", namespace: "not approved", pod: "bad pod", container: "app", tail: 201 }),
  });
  assert.equal(invalidRecentLog.status, 400);
  assert.equal(invalidRecentLog.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await invalidRecentLog.text(), /transport-log-/);
  const invalid = await fetch("http://127.0.0.1:43208/api/cluster", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ...scopeInput, resourceKinds: ["Secret"] }),
  });
  assert.equal(invalid.status, 400);
  if (savedScope) {
    await scopeDatabase.timeline.recordObservation(normalizePodObservation(savedScope, scopedResources[0], "2026-01-01T00:00:00.000Z"));
  }
  const timelineResponse = await fetch("http://127.0.0.1:43208/api/timeline?limit=10", { headers: { cookie } });
  assert.equal(timelineResponse.status, 200);
  assert.equal((await timelineResponse.json()).entries[0].observation.name, "in-scope");
  const invalidTimeline = await fetch("http://127.0.0.1:43208/api/timeline?limit=0", { headers: { cookie } });
  assert.equal(invalidTimeline.status, 400);
  const app = await fetch("http://127.0.0.1:43208/app?lang=en", { headers: { cookie } });
  assert.match(await app.text(), /Timeline/);
  const appChinese = await fetch("http://127.0.0.1:43208/app?lang=zh-CN", { headers: { cookie } });
  assert.match(await appChinese.text(), /Timeline/);
  const multilineExperimentForm = await fetch("http://127.0.0.1:43208/experiments?lang=en", {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      hypothesis: "multiline hypothesis",
      change: "multiline change",
      observation: "multiline observation",
      conclusion: "",
      state: "active",
      tags: "first\r\nsecond",
      workloads: "lab-cluster | tracegarden | Deployment | api\r\nlab-cluster | default | Pod | worker-0",
      gitRevision: "abc123",
    }),
  });
  assert.equal(multilineExperimentForm.status, 303);
  const multilineExperiments = await fetch("http://127.0.0.1:43208/api/experiments", { headers: { cookie } });
  const multilineExperiment = (await multilineExperiments.json()).experiments.find(({ hypothesis }) => hypothesis === "multiline hypothesis");
  assert.deepEqual(multilineExperiment.tags, ["first", "second"]);
  assert.deepEqual(multilineExperiment.workloads, [
    { clusterId: "lab-cluster", namespace: "tracegarden", kind: "Deployment", name: "api" },
    { clusterId: "lab-cluster", namespace: "default", kind: "Pod", name: "worker-0" },
  ]);
  for (const workloads of [
    "lab-cluster | tracegarden | Deployment | api | extra",
    "lab-cluster | tracegarden | Deployment",
  ]) {
    const malformedWorkloadForm = await fetch("http://127.0.0.1:43208/experiments?lang=en", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ hypothesis: "malformed", change: "malformed", observation: "malformed", conclusion: "", state: "active", tags: "", workloads, gitRevision: "" }),
    });
    assert.equal(malformedWorkloadForm.status, 400);
  }
  const invalidExperimentResponse = await fetch("http://127.0.0.1:43208/api/experiments", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ hypothesis: "invalid", change: "invalid", observation: "invalid", conclusion: "", state: "active", tags: [], workloads: [{ clusterId: "lab-cluster", namespace: "not approved", kind: "Pod", name: "bad name" }], gitRevision: "not a git revision" }),
  });
  assert.equal(invalidExperimentResponse.status, 400);
  const createdExperimentResponse = await fetch("http://127.0.0.1:43208/api/experiments", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ hypothesis: "**transport**", change: "change", observation: "observation", conclusion: "", state: "active", tags: ["transport"], workloads: [], gitRevision: null }),
  });
  assert.equal(createdExperimentResponse.status, 201);
  const createdExperiment = (await createdExperimentResponse.json()).experiment;
  const updatedExperimentResponse = await fetch(`http://127.0.0.1:43208/api/experiments/${createdExperiment.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      conclusion: "concluded",
      state: "concluded",
      workloads: [{ clusterId: "lab-cluster", namespace: "default", kind: "Deployment", name: "worker" }],
    }),
  });
  assert.equal(updatedExperimentResponse.status, 200);
  const updatedExperiment = (await updatedExperimentResponse.json()).experiment;
  assert.deepEqual(updatedExperiment.workloads, [{ clusterId: "lab-cluster", namespace: "default", kind: "Deployment", name: "worker" }]);
  const retrievedExperimentResponse = await fetch(`http://127.0.0.1:43208/api/experiments/${createdExperiment.id}`, { headers: { cookie } });
  assert.equal((await retrievedExperimentResponse.json()).experiment.id, createdExperiment.id);
} finally {
  await scopeRuntime.close();
}

const viewerToken = "viewer-cluster-token";
const viewerScopeRuntime = await createWebRuntime({
  database: scopeDatabase,
  admissionStore: {
    admit: async () => ({ admitted: false, reason: "admission_required" }),
    getSession: async (token) => token === viewerToken ? {
      token: viewerToken,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      member: {
        id: "viewer",
        workspaceId: "workspace-single",
        identity: ownerIdentity,
        role: "viewer",
        capabilities: [capabilities.workspaceRead, capabilities.timelineRead],
      },
    } : null,
  },
  identityAdapter,
  environment: { NODE_ENV: "test", HOST: "127.0.0.1" },
  port: 43209,
});
try {
  const viewerCookie = `tracegarden_session=${viewerToken}`;
  const denied = await fetch("http://127.0.0.1:43209/api/cluster", {
    method: "PUT",
    headers: { cookie: viewerCookie, "content-type": "application/json" },
    body: JSON.stringify(scopeInput),
  });
  assert.equal(denied.status, 403);
  const deniedLogs = await fetch("http://127.0.0.1:43209/api/logs/recent", {
    method: "POST",
    headers: { cookie: viewerCookie, "content-type": "application/json" },
    body: JSON.stringify({ clusterId: "lab-cluster", namespace: "tracegarden", pod: "api-0", container: "app", tail: 1, body: "viewer-protected" }),
  });
  assert.equal(deniedLogs.status, 403);
  assert.equal(deniedLogs.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await deniedLogs.text(), /viewer-protected/);
  const deniedLogsPage = await fetch("http://127.0.0.1:43209/logs/recent?lang=en", {
    method: "POST",
    headers: { cookie: viewerCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ clusterId: "lab-cluster", namespace: "tracegarden", pod: "api-0", container: "app", tail: "1" }),
  });
  assert.equal(deniedLogsPage.status, 403);
  assert.equal(deniedLogsPage.headers.get("cache-control"), "no-store");
  const deniedLogsPageBody = await deniedLogsPage.text();
  assert.match(deniedLogsPageBody, /do not have the Capability to read/);
  assert.doesNotMatch(deniedLogsPageBody, /viewer-protected/);
  const viewerAppZh = await fetch("http://127.0.0.1:43209/app?lang=zh-CN", { headers: { cookie: viewerCookie } });
  assert.equal(viewerAppZh.status, 200);
  assert.match(await viewerAppZh.text(), /没有配置 Cluster 观测范围的 Capability/);
  const viewerAppEn = await fetch("http://127.0.0.1:43209/app?lang=en", { headers: { cookie: viewerCookie } });
  const viewerAppEnBody = await viewerAppEn.text();
  assert.match(viewerAppEnBody, /do not have the Capability to configure/);
  assert.match(viewerAppEnBody, /do not have the Capability to read the Recent Log Window/);
  assert.doesNotMatch(viewerAppEnBody, /name="hypothesis"/);
  assert.doesNotMatch(viewerAppEnBody, /Create Experiment/);
  const viewerTimeline = await fetch("http://127.0.0.1:43209/api/timeline", { headers: { cookie: viewerCookie } });
  assert.equal(viewerTimeline.status, 200);
  const viewerExperiments = await fetch("http://127.0.0.1:43209/api/experiments", { headers: { cookie: viewerCookie } });
  assert.equal(viewerExperiments.status, 200);
  const viewerExperimentsBody = await viewerExperiments.json();
  assert.equal(viewerExperimentsBody.experiments.length, 2);
  const viewerExperimentId = viewerExperimentsBody.experiments[0].id;
  const viewerCreateExperiment = await fetch("http://127.0.0.1:43209/api/experiments", {
    method: "POST",
    headers: { cookie: viewerCookie, "content-type": "application/json" },
    body: JSON.stringify({ hypothesis: "viewer", change: "viewer", observation: "viewer", conclusion: "", state: "active", tags: [], workloads: [] }),
  });
  assert.equal(viewerCreateExperiment.status, 403);
  const viewerUpdateExperiment = await fetch(`http://127.0.0.1:43209/api/experiments/${viewerExperimentId}`, {
    method: "PATCH",
    headers: { cookie: viewerCookie, "content-type": "application/json" },
    body: JSON.stringify({ hypothesis: "viewer" }),
  });
  assert.equal(viewerUpdateExperiment.status, 403);
} finally {
  await viewerScopeRuntime.close();
}

const correlationObservation = (id, name, revision, labels, owners = []) => ({
  id,
  workspaceId: "workspace-single",
  occurredAt: "2026-01-01T00:00:00.000Z",
  clusterId: "lab-cluster",
  observation: {
    kind: "Pod",
    name,
    namespace: "default",
    clusterId: "lab-cluster",
    sourceIdentity: `lab-cluster:${id}`,
    ownerReferences: owners,
    labels,
    revision,
  },
});
const signalEntry = correlationObservation("uid-a", "api", "r1", { app: "api" });
const relatedSignalEntry = correlationObservation("uid-b", "worker", "r1", { app: "api" }, [{ kind: "Pod", name: "api", uid: "uid-a" }]);
assert.deepEqual(correlationSignalsBetween(signalEntry, relatedSignalEntry), ["time", "ownership", "label", "revision"]);
assert.equal(suggestCorrelationCandidates([signalEntry, relatedSignalEntry]).length, 1);
const correlationStore = new MemoryObservationStore();
const correlationScope = { workspaceId: "workspace-single", clusterId: "lab-cluster", name: "Lab", endpoint: "https://cluster.example.test", namespaces: ["default"], resourceKinds: ["Pod"] };
const correlationPod = normalizePodObservation(correlationScope, {
  kind: "Pod",
  metadata: { name: "api", namespace: "default", uid: "correlation-pod", resourceVersion: "1", labels: { app: "api" } },
  status: { phase: "Pending" },
}, "2026-01-01T00:00:00.000Z");
const correlationPersisted = await correlationStore.recordObservation(correlationPod);
await correlationStore.recordObservation(normalizePodObservation(correlationScope, {
  kind: "Pod",
  metadata: { name: "worker", namespace: "default", uid: "correlation-worker", resourceVersion: "2", labels: { app: "api" } },
  status: { phase: "Running" },
}, "2026-01-01T00:01:00.000Z"));
const correlationExperiment = await correlationStore.createExperiment("workspace-single", ownerActor.id, {
  hypothesis: "review",
  change: "adjust workload",
  observation: "pending",
  conclusion: "",
  state: "active",
  tags: [],
  workloads: [{ clusterId: "lab-cluster", namespace: "default", kind: "Pod", name: "api" }],
  gitRevision: null,
});
const pendingCorrelation = await correlationStore.listCorrelationSuggestions("workspace-single");
assert.ok(pendingCorrelation.length > 0);
const experimentCorrelation = pendingCorrelation.find((candidate) => candidate.leftEntryId === correlationExperiment.timelineEntryId || candidate.rightEntryId === correlationExperiment.timelineEntryId);
assert.ok(experimentCorrelation);
assert.ok(hasCorrelationReview(ownerActor));
const confirmedCorrelation = await confirmCorrelationSuggestion(ownerActor, correlationStore, experimentCorrelation.id);
assert.equal(confirmedCorrelation?.confirmedLink?.confirmedByMemberId, ownerActor.id);
assert.equal((await confirmCorrelationSuggestion(ownerActor, correlationStore, experimentCorrelation.id))?.idempotent, true);
const linkedObservation = await correlationStore.getTimelineEntry("workspace-single", correlationPersisted.entry.id);
assert.equal(linkedObservation?.confirmedLinks?.length, 1);
const linkedExperiment = await correlationStore.getExperiment("workspace-single", correlationExperiment.id);
assert.equal(linkedExperiment?.confirmedLinks?.length, 1);
if (invitedAdmission.admitted) await assert.rejects(() => rejectCorrelationSuggestion(invitedAdmission.session.member, correlationStore, experimentCorrelation.id), /Missing capability/);
const rejectionCandidate = (await correlationStore.listCorrelationSuggestions("workspace-single")).find((candidate) => candidate.id !== experimentCorrelation.id);
if (rejectionCandidate) {
  const rejectedCorrelation = await rejectCorrelationSuggestion(ownerActor, correlationStore, rejectionCandidate.id);
  assert.equal(rejectedCorrelation?.suggestion.status, "rejected");
  assert.equal((await correlationStore.listCorrelationSuggestions("workspace-single")).some((candidate) => candidate.id === rejectionCandidate.id), false);
}

let migrationFailed = false;
try {
  await createWebRuntime({
    database: { kind: "postgres", clusterScope: new MemoryClusterScopeStore(), migrate: async () => { throw new Error("migration failed"); }, ping: async () => true, close: async () => {} },
    port: 0,
  });
} catch {
  migrationFailed = true;
}
assert.equal(migrationFailed, true);
let productionMemoryRejected = false;
try {
  createDatabase({ NODE_ENV: "production", DATABASE_MODE: "memory" });
} catch {
  productionMemoryRejected = true;
}
assert.equal(productionMemoryRejected, true);
assert.throws(
  () => createDatabase({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://tracegarden:local-only@127.0.0.1:5432/tracegarden",
    TRACEGARDEN_BOOTSTRAP_ISSUER: GOOGLE_ISSUER,
    TRACEGARDEN_BOOTSTRAP_SUBJECT: "bootstrap",
  }),
  /TIMELINE_CURSOR_SECRET is required in production/,
);
assert.throws(() => createDatabase({ DATABASE_MODE: "memory" }));
await assert.rejects(
  createWebRuntime({ database: new MemoryDatabase(), environment: { NODE_ENV: "production" }, port: 0 }),
  /Memory database is not allowed in production/,
);
console.log("unit, Experiment, Cluster scope, and collector readiness checks passed");
