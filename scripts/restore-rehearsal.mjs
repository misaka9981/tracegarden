import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { decryptBackupBuffer, decodeEncryptionKey, safePostgresDatabaseUrl } from "./backup.mjs";

export const REQUIRED_MIGRATION_IDS = [
  "0001_foundation",
  "0002_workspace_admission",
  "0003_better_auth",
  "0004_membership_management",
  "0005_cluster_scope",
  "0006_observation_timeline",
  "0007_recent_logs",
  "0008_normalized_observations",
  "0009_observation_checkpoints",
  "0010_timeline_attention",
  "0011_structured_experiments",
  "0012_correlation_links",
  "0013_live_timeline",
  "0014_observation_retention",
];

export const REQUIRED_TABLES = [
  "tracegarden_schema_migrations",
  "tracegarden_runtime_status",
  "tracegarden_workspaces",
  "tracegarden_external_identities",
  "tracegarden_members",
  "tracegarden_invitations",
  "tracegarden_capabilities",
  "tracegarden_role_capabilities",
  "tracegarden_sessions",
  "user",
  "session",
  "account",
  "verification",
  "tracegarden_audit_records",
  "tracegarden_clusters",
  "tracegarden_observations",
  "tracegarden_timeline_entries",
  "tracegarden_ingestion_checkpoints",
  "tracegarden_attention_items",
  "tracegarden_attention_reviews",
  "tracegarden_experiments",
  "tracegarden_experiment_workloads",
  "tracegarden_correlation_suggestions",
  "tracegarden_confirmed_links",
  "tracegarden_retention_policies",
];

export const REQUIRED_FOREIGN_KEYS = [
  "tracegarden_members_workspace_id_fkey",
  "tracegarden_members_external_identity_id_fkey",
  "tracegarden_invitations_workspace_id_fkey",
  "tracegarden_role_capabilities_capability_fkey",
  "tracegarden_sessions_member_id_fkey",
  "session_userId_fkey",
  "account_userId_fkey",
  "tracegarden_audit_records_workspace_id_fkey",
  "tracegarden_audit_records_actor_member_id_fkey",
  "tracegarden_clusters_workspace_id_fkey",
  "tracegarden_observations_workspace_id_fkey",
  "tracegarden_timeline_entries_workspace_id_fkey",
  "tracegarden_timeline_entries_observation_id_fkey",
  "tracegarden_ingestion_checkpoints_workspace_id_fkey",
  "tracegarden_attention_items_entry_id_fkey",
  "tracegarden_attention_items_workspace_id_fkey",
  "tracegarden_attention_reviews_entry_id_fkey",
  "tracegarden_attention_reviews_member_id_fkey",
  "tracegarden_experiments_workspace_id_fkey",
  "tracegarden_experiments_created_by_member_id_fkey",
  "tracegarden_experiment_workloads_experiment_id_fkey",
  "tracegarden_experiment_workloads_workspace_id_fkey",
  "tracegarden_experiment_workloads_experiment_scope_fk",
  "tracegarden_experiment_workloads_cluster_scope_fk",
  "tracegarden_timeline_entries_experiment_id_fkey",
  "tracegarden_correlation_suggestions_workspace_id_fkey",
  "tracegarden_correlation_suggestions_left_entry_id_fkey",
  "tracegarden_correlation_suggestions_right_entry_id_fkey",
  "tracegarden_correlation_suggestions_decided_by_member_id_fkey",
  "tracegarden_confirmed_links_workspace_id_fkey",
  "tracegarden_confirmed_links_suggestion_id_fkey",
  "tracegarden_confirmed_links_left_entry_id_fkey",
  "tracegarden_confirmed_links_right_entry_id_fkey",
  "tracegarden_confirmed_links_confirmed_by_member_id_fkey",
  "tracegarden_observations_workspace_cluster_fk",
  "tracegarden_timeline_entries_workspace_cluster_fk",
  "tracegarden_ingestion_checkpoints_workspace_cluster_fk",
  "tracegarden_retention_policies_workspace_id_fkey",
];

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`missing restore configuration: ${name}`);
  return value;
}

export async function assertCleanDatabase(client) {
  const result = await client.query(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name
  `);
  if (result.rows.length) throw new Error("restore target must be a clean PostgreSQL database");
}

export async function checkRestoredDatabase(client) {
  const tables = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name",
    [REQUIRED_TABLES],
  );
  const found = new Set(tables.rows.map((row) => row.table_name));
  const missing = REQUIRED_TABLES.filter((table) => !found.has(table));
  if (missing.length) throw new Error("restored PostgreSQL schema is incomplete");

  const migrations = await client.query(
    "SELECT id FROM public.tracegarden_schema_migrations WHERE id = ANY($1::text[]) ORDER BY id",
    [REQUIRED_MIGRATION_IDS],
  );
  const applied = new Set(migrations.rows.map((row) => row.id));
  if (REQUIRED_MIGRATION_IDS.some((id) => !applied.has(id))) {
    throw new Error("restored PostgreSQL migration coverage is incomplete");
  }

  const counts = {};
  for (const table of REQUIRED_TABLES) {
    const identifier = table.replaceAll('"', '""');
    const result = await client.query(`SELECT count(*)::bigint AS count FROM public."${identifier}"`);
    counts[table] = Number(result.rows[0].count);
  }
  const applicationReadable = await client.query(`
    SELECT w.id, w.name, count(DISTINCT t.id)::bigint AS timeline_entries
    FROM tracegarden_workspaces AS w
    LEFT JOIN tracegarden_timeline_entries AS t ON t.workspace_id = w.id
    GROUP BY w.id, w.name
    ORDER BY w.id
    LIMIT 1
  `);
  if (!applicationReadable.rows.length) throw new Error("restored application state is not readable");
  const constraints = await client.query(
    "SELECT conname, convalidated FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'f' AND conname = ANY($1::text[])",
    [REQUIRED_FOREIGN_KEYS],
  );
  const foundConstraints = new Map(constraints.rows.map((row) => [row.conname, row.convalidated]));
  if (REQUIRED_FOREIGN_KEYS.some((name) => foundConstraints.get(name) !== true)) {
    throw new Error("restored PostgreSQL foreign-key constraints are not validated");
  }
  return {
    counts,
    applicationReadable: true,
    migrationCoverage: true,
    tablesVerified: true,
    foreignKeysValidated: true,
  };
}

async function restoreDump(artifactPath, databaseUrl, keyFile, environment) {
  const artifact = await readFile(artifactPath);
  const key = decodeEncryptionKey(await readFile(keyFile));
  const dump = decryptBackupBuffer(artifact, key);
  const directory = await mkdtemp(join(tmpdir(), "tracegarden-restore-"));
  const dumpPath = join(directory, "restored.dump");
  try {
    await writeFile(dumpPath, dump, { mode: 0o600 });
    const safe = safePostgresDatabaseUrl(databaseUrl, "RESTORE_DATABASE_URL");
    await new Promise((resolveProcess, reject) => {
      const child = spawn("pg_restore", [
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        "--single-transaction",
        `--dbname=${safe.url}`,
        dumpPath,
      ], {
        env: { ...environment, PGPASSWORD: safe.password },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr.resume();
      child.once("error", () => reject(new Error("pg_restore could not be started")));
      child.once("close", (code) => code === 0 ? resolveProcess() : reject(new Error("pg_restore failed")));
    });
  } catch {
    throw new Error("clean PostgreSQL restore failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runRestoreRehearsal(environment = process.env, { clientFactory = (url) => new pg.Client(url) } = {}) {
  const artifactPath = requiredEnvironment(environment, "RESTORE_ARTIFACT_PATH");
  const databaseUrl = requiredEnvironment(environment, "RESTORE_DATABASE_URL");
  safePostgresDatabaseUrl(databaseUrl, "RESTORE_DATABASE_URL");
  const keyFile = requiredEnvironment(environment, "RESTORE_ENCRYPTION_KEY_FILE");
  if (requiredEnvironment(environment, "RESTORE_TARGET_MUST_BE_CLEAN") !== "true") {
    throw new Error("RESTORE_TARGET_MUST_BE_CLEAN=true is required");
  }
  const client = clientFactory(databaseUrl);
  await client.connect();
  try {
    await assertCleanDatabase(client);
  } finally {
    await client.end();
  }
  await restoreDump(artifactPath, databaseUrl, keyFile, environment);
  const restoredClient = clientFactory(databaseUrl);
  await restoredClient.connect();
  try {
    const checks = await checkRestoredDatabase(restoredClient);
    return { status: "passed", ...checks };
  } finally {
    await restoredClient.end();
  }
}

export async function main(environment = process.env) {
  try {
    const result = await runRestoreRehearsal(environment);
    console.log(JSON.stringify({ event: "restore.rehearsal.passed", ...result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const safeMessage = /^(missing restore configuration: [A-Z0-9_]+|RESTORE_DATABASE_URL must (?:be (?:a PostgreSQL URL|a valid PostgreSQL URL)|not contain credential-bearing query parameters(?: or fragments)?)|restore target must be a clean PostgreSQL database|restored PostgreSQL schema is incomplete|restored PostgreSQL migration coverage is incomplete|restored application state is not readable|restored PostgreSQL foreign-key constraints are not validated|pg_restore (?:could not be started|failed)|clean PostgreSQL restore failed|backup artifact envelope is invalid|backup artifact encryption is unsupported|backup artifact initialization vector is invalid|backup artifact integrity check failed|backup encryption key must be (?:a 32-byte hexadecimal or base64 value|32 bytes))$/.test(message)
      ? message
      : "unexpected restore rehearsal failure";
    console.error(`restore rehearsal failed: ${safeMessage}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
