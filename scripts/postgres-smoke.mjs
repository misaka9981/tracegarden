import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";

const name = `tracegarden-foundation-pg-${process.pid}`;
const databasePort = 45433;
const webPort = 43200;
const productionWebPort = 43201;
let web;
let productionWeb;
const databaseUrl = `postgresql://tracegarden:local-only@127.0.0.1:${databasePort}/tracegarden`;

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
  const migrationCount = docker("exec", name, "psql", "-At", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT count(*) FROM tracegarden_schema_migrations WHERE id IN ('0001_foundation', '0002_workspace_admission', '0003_better_auth', '0004_membership_management');");
  assert.equal(migrationCount, "4");
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
  assert.equal(auditCount, "8");
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
  console.log("PostgreSQL migration, admission, and Better Auth production integration smoke passed");
} finally {
  web?.kill("SIGTERM");
  productionWeb?.kill("SIGTERM");
  removeDatabase();
}
