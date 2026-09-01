import assert from "node:assert/strict";
import { CollectorRecoveryError, collectorStatus, createCollectorRuntime } from "../dist/apps/collector/src/main.js";
import { createWebRuntime, renderStatusPage } from "../dist/apps/web/src/server.js";
import { createDatabase, MemoryAdmissionStore, MemoryClusterScopeStore, MemoryDatabase, MemoryObservationStore } from "../dist/packages/db/src/index.js";
import { capabilities, createBetterAuthRuntime, createIdentityAdapter, GOOGLE_ISSUER, googleOAuthConfig, hasCapability, LocalIdentityAdapter } from "../dist/packages/identity/src/index.js";
import { catalogs, parseLanguage } from "../dist/packages/i18n/src/index.js";
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
  configureClusterScope,
  ConfiguredKubernetesAdapter,
  DeterministicKubernetesAdapter,
  createKubernetesAdapter,
  hasClusterConfigureCapability,
  normalizePodObservation,
  productionKubernetesConfiguration,
  validateClusterScopeInput,
} from "../dist/packages/cluster/src/index.js";

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

const productionRuntime = await createWebRuntime({
  database: {
    kind: "postgres",
    admission: new MemoryAdmissionStore({ issuer: GOOGLE_ISSUER, subject: "test-google-subject" }),
    clusterScope: new MemoryClusterScopeStore(),
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
    database: { kind: "postgres", migrate: async () => {}, ping: async () => true, close: async () => {} },
    environment: {
      NODE_ENV: "production",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GOOGLE_REDIRECT_URI: "https://tracegarden.test/api/auth/callback/google",
      BETTER_AUTH_SECRET: "test-secret-secret",
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
const callbackRuntime = await createWebRuntime({
  database: {
    kind: "postgres",
    admission: callbackAdmissionStore,
    clusterScope: new MemoryClusterScopeStore(),
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
const scopedResources = savedScope ? await collectScopedResources(savedScope, deterministic) : [];
assert.deepEqual(scopedResources.map((resource) => resource.metadata.name), ["in-scope"]);
assert.equal(deterministic.requests[0]?.clusterId, "lab-cluster");
const normalizedPod = savedScope ? normalizePodObservation(savedScope, scopedResources[0], "2026-01-01T00:00:00.000Z") : null;
assert.equal(normalizedPod?.sourceIdentity, "lab-cluster:pod-uid-1");
assert.equal(normalizedPod?.phase, "Running");
assert.equal(normalizedPod?.ready, true);
const memoryTimeline = new MemoryObservationStore();
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
} finally {
  await collectorWithPersistence.close();
}
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
const originalFetch = globalThis.fetch;
globalThis.fetch = async (request, init) => {
  assert.match(String(request), /https:\/\/cluster\.example\.test\/persisted\/api\/v1\/namespaces\/tracegarden\/pods/);
  assert.equal(init?.headers && init.headers.authorization, "Bearer local-test-token");
  return new Response(JSON.stringify({ items: [{ metadata: { name: "configured", namespace: "tracegarden", uid: "configured-uid", resourceVersion: "9" }, status: { phase: "Running" } }] }), { status: 200, headers: { "content-type": "application/json" } });
};
try {
  const configuredScope = savedScope ? { ...savedScope, endpoint: "https://cluster.example.test/persisted", namespaces: ["tracegarden"], resourceKinds: ["Pod"] } : null;
  const configuredResources = configuredScope ? await configuredAdapter.list(configuredScope) : [];
  assert.equal(configuredResources[0]?.metadata.name, "configured");
  assert.equal(configuredAdapter.contacted, true);
  const mismatchedAdapter = new ConfiguredKubernetesAdapter({ endpoint: "https://other-cluster.example.test", token: "local-test-token" });
  if (configuredScope) await assert.rejects(mismatchedAdapter.list(configuredScope), /does not match/);
} finally {
  globalThis.fetch = originalFetch;
}

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

const collector = collectorStatus();
assert.equal(collector.status, "ready");
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
} finally {
  await scopeRuntime.close();
}

const viewerToken = "viewer-cluster-token";
const viewerScopeRuntime = await createWebRuntime({
  database: new MemoryDatabase(),
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
  const viewerTimeline = await fetch("http://127.0.0.1:43209/api/timeline", { headers: { cookie: viewerCookie } });
  assert.equal(viewerTimeline.status, 200);
} finally {
  await viewerScopeRuntime.close();
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
assert.throws(() => createDatabase({ DATABASE_MODE: "memory" }));
await assert.rejects(
  createWebRuntime({ database: new MemoryDatabase(), environment: { NODE_ENV: "production" }, port: 0 }),
  /Memory database is not allowed in production/,
);
console.log("unit, Cluster scope, and collector readiness checks passed");
