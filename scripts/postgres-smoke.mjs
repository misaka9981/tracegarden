import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";

const name = `tracegarden-foundation-pg-${process.pid}`;
const databasePort = 45433;
const webPort = 43200;
let web;
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
      docker("exec", name, "pg_isready", "-U", "tracegarden", "-d", "tracegarden");
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
  const migrationCount = docker("exec", name, "psql", "-At", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT count(*) FROM tracegarden_schema_migrations WHERE id = '0001_foundation';");
  assert.equal(migrationCount, "1");
  console.log("PostgreSQL migration and web readiness smoke passed");
} finally {
  web?.kill("SIGTERM");
  removeDatabase();
}
