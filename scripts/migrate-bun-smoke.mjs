import assert from "node:assert/strict";
import pg from "pg";
import { execFileSync, spawn } from "node:child_process";

const name = `tracegarden-migrate-bun-${process.pid}`;
const postgresImage = "postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7";
const suppliedDatabaseUrl = process.env.MIGRATION_BUN_DATABASE_URL?.trim();
const port = suppliedDatabaseUrl ? new URL(suppliedDatabaseUrl).port : String(45_000 + (process.pid % 900));
const databaseUrl = suppliedDatabaseUrl || `postgresql://tracegarden:local-only@127.0.0.1:${port}/tracegarden`;
const ownsDatabaseContainer = !suppliedDatabaseUrl;
const failureDatabase = `tracegarden_migrate_failure_${process.pid}`;
const failureDatabaseUrl = new URL(databaseUrl);
failureDatabaseUrl.pathname = `/${failureDatabase}`;
const adminDatabaseUrl = new URL(databaseUrl);
adminDatabaseUrl.pathname = "/postgres";
const failureUrl = failureDatabaseUrl.toString();
const adminUrl = adminDatabaseUrl.toString();

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function imageAvailable(image) {
  try {
    docker(["image", "inspect", image]);
    return true;
  } catch {
    return false;
  }
}
async function waitForPostgres() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      docker(["exec", name, "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT 1"]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("migration Bun smoke PostgreSQL did not become ready");
}
function runMigration(url, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn("bun", ["dist/apps/migrate/src/main.js"], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_URL: url,
        MIGRATION_DATABASE_READY_TIMEOUT_SECONDS: "10",
        MIGRATION_DATABASE_READY_RETRY_SECONDS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, 1_000);
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, output });
    };
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}
async function query(url, text, values = []) {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  });
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}

if (ownsDatabaseContainer) {
  assert.equal(imageAvailable(postgresImage), true, `migration Bun smoke requires the preloaded PostgreSQL image ${postgresImage}; refusing to pull it`);
}
try {
  if (ownsDatabaseContainer) {
    try { docker(["rm", "-f", name]); } catch { /* run tag was not present */ }
    docker([
      "run", "--pull=never", "-d", "--name", name,
      "-p", `127.0.0.1:${port}:5432`,
      "-e", "POSTGRES_DB=tracegarden", "-e", "POSTGRES_USER=tracegarden", "-e", "POSTGRES_PASSWORD=local-only",
      postgresImage,
    ]);
    await waitForPostgres();
  }

  const fresh = await runMigration(databaseUrl);
  assert.equal(fresh.code, 0, `Bun fresh migration failed: ${fresh.output}`);
  assert.match(fresh.output, /Tracegarden migrations applied/);
  const freshCount = await query(databaseUrl, "SELECT count(*)::text AS count FROM tracegarden_schema_migrations");
  assert.deepEqual(freshCount.rows, [{ count: "15" }]);

  const upgrade = await runMigration(databaseUrl);
  assert.equal(upgrade.code, 0, `Bun upgrade migration failed: ${upgrade.output}`);
  const upgradeCount = await query(databaseUrl, "SELECT count(*)::text AS count FROM tracegarden_schema_migrations");
  assert.deepEqual(upgradeCount.rows, [{ count: "15" }]);

  const concurrent = await Promise.all([runMigration(databaseUrl), runMigration(databaseUrl)]);
  assert.ok(concurrent.every(({ code }) => code === 0), `Bun concurrent migration failed: ${concurrent.map(({ output }) => output).join(" | ")}`);
  const concurrentCount = await query(databaseUrl, "SELECT count(*)::text AS count, count(DISTINCT id)::text AS distinct_count FROM tracegarden_schema_migrations");
  assert.deepEqual(concurrentCount.rows, [{ count: "15", distinct_count: "15" }]);

  await query(adminUrl, `CREATE DATABASE "${failureDatabase}"`);
  await query(failureUrl, `
    CREATE TABLE tracegarden_schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO tracegarden_schema_migrations (id) VALUES ('0001_foundation');
    CREATE TABLE tracegarden_workspaces (id text PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE migration_failure_marker (id integer PRIMARY KEY, touched boolean NOT NULL DEFAULT false);
    INSERT INTO migration_failure_marker (id) VALUES (1);
    CREATE FUNCTION fail_migration_after_workspace_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE migration_failure_marker SET touched = true WHERE id = 1;
      RAISE EXCEPTION 'intentional transactional migration failure';
    END;
    $$;
    CREATE TRIGGER migration_failure_after_workspace_insert
      AFTER INSERT ON tracegarden_workspaces
      FOR EACH ROW EXECUTE FUNCTION fail_migration_after_workspace_insert();
  `);
  const failed = await runMigration(failureUrl);
  assert.notEqual(failed.code, 0, "Bun failed migration unexpectedly succeeded");
  assert.match(failed.output, /Tracegarden database migration failed/);
  const rolledBack = await query(failureUrl, `
    SELECT
      to_regclass('public.tracegarden_external_identities')::text AS external_identities,
      to_regclass('public.tracegarden_capabilities')::text AS capabilities,
      (SELECT count(*)::text FROM tracegarden_workspaces) AS workspace_count,
      (SELECT touched FROM migration_failure_marker WHERE id = 1) AS marker_touched,
      (SELECT count(*)::text FROM tracegarden_schema_migrations WHERE id = '0002_workspace_admission') AS migration_row_count
  `);
  assert.deepEqual(rolledBack.rows, [{
    external_identities: null,
    capabilities: null,
    workspace_count: "0",
    marker_touched: false,
    migration_row_count: "0",
  }]);
  await query(failureUrl, "DROP TRIGGER migration_failure_after_workspace_insert ON tracegarden_workspaces; DROP FUNCTION fail_migration_after_workspace_insert();");
  const retry = await runMigration(failureUrl);
  assert.equal(retry.code, 0, `Bun migration retry failed: ${retry.output}`);
  const retryCount = await query(failureUrl, "SELECT count(*)::text AS count FROM tracegarden_schema_migrations");
  assert.deepEqual(retryCount.rows, [{ count: "15" }]);
  console.log("Bun migration fresh-install, upgrade, concurrent-lock, failed-rollback, and retry checks passed");
} finally {
  try { await query(adminUrl, `DROP DATABASE IF EXISTS "${failureDatabase}"`); } catch { /* cleanup is best effort */ }
  if (ownsDatabaseContainer) {
    try { docker(["rm", "-f", name]); } catch { /* cleanup is best effort */ }
  }
}
