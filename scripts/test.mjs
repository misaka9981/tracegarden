import assert from "node:assert/strict";
import { collectorStatus, createCollectorRuntime } from "../dist/apps/collector/src/main.js";
import { createWebRuntime, renderStatusPage } from "../dist/apps/web/src/server.js";
import { createDatabase, MemoryAdmissionStore, MemoryClusterScopeStore, MemoryDatabase } from "../dist/packages/db/src/index.js";
import { capabilities, createBetterAuthRuntime, createIdentityAdapter, GOOGLE_ISSUER, googleOAuthConfig, hasCapability, LocalIdentityAdapter } from "../dist/packages/identity/src/index.js";
import { catalogs, parseLanguage } from "../dist/packages/i18n/src/index.js";
import {
  collectScopedResources,
  configureClusterScope,
  DeterministicKubernetesAdapter,
  createKubernetesAdapter,
  hasClusterConfigureCapability,
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
  { kind: "Pod", metadata: { name: "in-scope", namespace: "tracegarden" } },
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
const viewerMember = ownerMember ? { ...ownerMember, role: "viewer", capabilities: [capabilities.workspaceRead, capabilities.timelineRead] } : null;
if (viewerMember) await assert.rejects(configureClusterScope(viewerMember, scopeStore, scopeInput), /cluster:configure/);
assert.equal(productionKubernetesConfiguration({ NODE_ENV: "production" }), null);
const inertAdapter = createKubernetesAdapter({ NODE_ENV: "production" });
assert.equal(inertAdapter.kind, "inert");
assert.equal(inertAdapter.contacted, false);
if (savedScope) assert.deepEqual(await collectScopedResources(savedScope, inertAdapter), []);

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

const scopeRuntime = await createWebRuntime({
  database: new MemoryDatabase(),
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
  const invalid = await fetch("http://127.0.0.1:43208/api/cluster", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ...scopeInput, resourceKinds: ["Secret"] }),
  });
  assert.equal(invalid.status, 400);
  const app = await fetch("http://127.0.0.1:43208/app?lang=en", { headers: { cookie } });
  assert.match(await app.text(), /Cluster observation scope/);
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
  const viewerAppZh = await fetch("http://127.0.0.1:43209/app?lang=zh-CN", { headers: { cookie: viewerCookie } });
  assert.equal(viewerAppZh.status, 200);
  assert.match(await viewerAppZh.text(), /没有配置 Cluster 观测范围的 Capability/);
  const viewerAppEn = await fetch("http://127.0.0.1:43209/app?lang=en", { headers: { cookie: viewerCookie } });
  assert.match(await viewerAppEn.text(), /do not have the Capability to configure/);
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
