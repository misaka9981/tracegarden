import assert from "node:assert/strict";
import { collectorStatus, createCollectorRuntime } from "../dist/apps/collector/src/main.js";
import { createWebRuntime, renderStatusPage } from "../dist/apps/web/src/server.js";
import { createDatabase, MemoryAdmissionStore, MemoryDatabase } from "../dist/packages/db/src/index.js";
import { capabilities, createBetterAuthRuntime, createIdentityAdapter, GOOGLE_ISSUER, googleOAuthConfig, hasCapability, LocalIdentityAdapter } from "../dist/packages/identity/src/index.js";
import { catalogs, parseLanguage } from "../dist/packages/i18n/src/index.js";

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
if (ownerAdmission.admitted) {
  assert.equal(ownerAdmission.session.member.role, "owner");
  assert.ok(hasCapability(ownerAdmission.session.member, capabilities.membershipManage));
  assert.equal((await admissionStore.getSession(ownerAdmission.session.token))?.member.identity.subject, "owner");
}
const rejectedAdmission = await admissionStore.admit(rejectedIdentity);
assert.equal(rejectedAdmission.admitted, false);
assert.equal(admissionStore.memberCount(), 1);
const invitedIdentity = identityAdapter.resolve("invited");
assert.ok(invitedIdentity);
await admissionStore.createInvitation(invitedIdentity.email.toUpperCase());
const invitedAdmission = await admissionStore.admit(invitedIdentity);
assert.equal(invitedAdmission.admitted, true);
if (invitedAdmission.admitted) assert.equal(invitedAdmission.session.member.role, "viewer");
assert.equal(admissionStore.memberCount(), 2);
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

const collector = collectorStatus();
assert.equal(collector.status, "ready");
assert.equal(collector.checks.clusterContacted, false);
const collectorRuntime = await createCollectorRuntime({ port: 43202, host: "127.0.0.1" });
try {
  const collectorResponse = await fetch("http://127.0.0.1:43202/health/readiness");
  assert.equal(collectorResponse.status, 200);
  const collectorReadiness = await collectorResponse.json();
  assert.equal(collectorReadiness.status, "ready");
  assert.equal(collectorReadiness.checks.clusterContacted, false);
} finally {
  await collectorRuntime.close();
}

let migrationFailed = false;
try {
  await createWebRuntime({
    database: { kind: "postgres", migrate: async () => { throw new Error("migration failed"); }, ping: async () => true, close: async () => {} },
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
console.log("unit and collector readiness checks passed");
