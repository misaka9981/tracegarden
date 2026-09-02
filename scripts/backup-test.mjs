import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptBackupBuffer, encryptBackupBuffer, runBackup, safePostgresDatabaseUrl, uploadWithAws, validateBackupConfiguration } from "./backup.mjs";
import {
  assertCleanDatabase,
  checkRestoredDatabase,
  REQUIRED_FOREIGN_KEYS,
  REQUIRED_MIGRATION_IDS,
  REQUIRED_TABLES,
} from "./restore-rehearsal.mjs";

const directory = await mkdtemp(join(tmpdir(), "tracegarden-backup-test-"));
const key = Buffer.alloc(32, 7);
const keyFile = join(directory, "encryption-key");
const sigV4VectorPath = join(directory, "sigv4-vector.dump.enc");
await writeFile(keyFile, key.toString("hex"), { mode: 0o600 });
const environment = {
  DATABASE_URL: "postgresql://tracegarden@database.invalid:5432/tracegarden",
  BACKUP_ENDPOINT: "https://storage.invalid",
  BACKUP_BUCKET: "tracegarden-backups",
  BACKUP_SCHEDULE: "0 2 * * *",
  BACKUP_RETENTION_DAYS: "30",
  BACKUP_DESTINATION_SCOPE: "off-vm",
  BACKUP_CREDENTIALS_SOURCE: "kubernetes-secret/backup-storage",
  BACKUP_ENCRYPTION_MECHANISM: "aes-256-gcm",
  BACKUP_ENCRYPTION_KEY_FILE: keyFile,
};
const plaintext = Buffer.from("offline PostgreSQL custom-format fixture\n");
try {
  const artifact = encryptBackupBuffer(plaintext, key);
  assert.notEqual(artifact.includes(plaintext), true, "plaintext must not be present in the encrypted artifact");
  assert.deepEqual(decryptBackupBuffer(artifact, key), plaintext);
  assert.throws(() => decryptBackupBuffer(artifact, Buffer.alloc(32, 8)), /integrity check failed/);
  assert.throws(() => validateBackupConfiguration({ ...environment, BACKUP_DESTINATION_SCOPE: "same-vm" }), /off-VM/);
  assert.throws(() => validateBackupConfiguration({ ...environment, BACKUP_ENCRYPTION_MECHANISM: "none" }), /aes-256-gcm/);
  assert.throws(() => validateBackupConfiguration({ ...environment, BACKUP_CREDENTIALS_SOURCE: "environment" }), /Kubernetes Secret/);
  assert.throws(() => validateBackupConfiguration({ ...environment, DATABASE_URL: "postgresql://tracegarden@database.invalid:5432/tracegarden?password=leaked" }), /credential-bearing query parameters/);
  assert.throws(() => validateBackupConfiguration({ ...environment, BACKUP_ENDPOINT: "https://storage.invalid/?X-Amz-Credential=leaked" }), /query parameters/);
  assert.throws(() => validateBackupConfiguration({ ...environment, BACKUP_ENDPOINT: "https://:" }), /valid HTTPS URL/);
  assert.throws(() => validateBackupConfiguration({ ...environment, BACKUP_ENDPOINT: "https://storage.invalid/a b" }), /valid HTTPS URL/);
  assert.deepEqual(safePostgresDatabaseUrl("postgresql://tracegarden:secret@database.invalid:5432/tracegarden?sslmode=require"), {
    url: "postgresql://tracegarden@database.invalid:5432/tracegarden?sslmode=require",
    password: "secret",
  });

  const cleanClient = { query: async () => ({ rows: [] }) };
  await assertCleanDatabase(cleanClient);
  await assert.rejects(
    assertCleanDatabase({ query: async () => ({ rows: [{ table_schema: "public", table_name: "tracegarden_workspaces" }] }) }),
    /clean PostgreSQL database/,
  );
  const makeRestoredClient = ({ missingTables = [], missingMigrations = [], missingForeignKeys = [], invalidForeignKeys = [] } = {}) => ({
    query: async (sql) => {
      if (sql.includes("information_schema.tables")) return { rows: REQUIRED_TABLES
        .filter((table) => !missingTables.includes(table))
        .map((table_name) => ({ table_name })) };
      if (sql.includes("SELECT id FROM public.tracegarden_schema_migrations")) return { rows: REQUIRED_MIGRATION_IDS
        .filter((id) => !missingMigrations.includes(id))
        .map((id) => ({ id })) };
      if (sql.includes("pg_constraint")) return { rows: REQUIRED_FOREIGN_KEYS
        .filter((conname) => !missingForeignKeys.includes(conname))
        .map((conname) => ({ conname, convalidated: !invalidForeignKeys.includes(conname) })) };
      if (sql.includes("GROUP BY")) return { rows: [{ id: "workspace", name: "Workspace", timeline_entries: "1" }] };
      return { rows: [{ count: "1" }] };
    },
  });
  assert.deepEqual(await checkRestoredDatabase(makeRestoredClient()), {
    counts: Object.fromEntries(REQUIRED_TABLES.map((table) => [table, 1])),
    applicationReadable: true,
    migrationCoverage: true,
    tablesVerified: true,
    foreignKeysValidated: true,
  });
  await assert.rejects(
    checkRestoredDatabase(makeRestoredClient({ missingMigrations: ["0014_observation_retention"] })),
    /migration coverage/,
  );
  await assert.rejects(
    checkRestoredDatabase(makeRestoredClient({ missingTables: ["tracegarden_audit_records"] })),
    /schema is incomplete/,
  );
  await assert.rejects(
    checkRestoredDatabase(makeRestoredClient({ missingTables: ["tracegarden_correlation_suggestions"] })),
    /schema is incomplete/,
  );
  await assert.rejects(
    checkRestoredDatabase(makeRestoredClient({ missingTables: ["tracegarden_retention_policies"] })),
    /schema is incomplete/,
  );
  await assert.rejects(
    checkRestoredDatabase(makeRestoredClient({ missingForeignKeys: ["tracegarden_confirmed_links_workspace_member_fk"] })),
    /foreign-key constraints/,
  );
  await assert.rejects(
    checkRestoredDatabase(makeRestoredClient({ invalidForeignKeys: ["tracegarden_confirmed_links_workspace_member_fk"] })),
    /foreign-key constraints/,
  );
  await assert.rejects(
    checkRestoredDatabase(makeRestoredClient({ invalidForeignKeys: ["tracegarden_retention_policies_workspace_id_fkey"] })),
    /foreign-key constraints/,
  );

  let uploaded;
  const result = await runBackup({
    environment,
    dump: async () => plaintext,
    upload: async (request) => { uploaded = await readFile(request.artifactPath); },
    now: new Date("2026-01-02T03:04:05.000Z"),
  });
  assert.ok(uploaded);
  assert.notEqual(uploaded.includes(plaintext), true, "uploader must receive encrypted bytes only");
  assert.deepEqual(decryptBackupBuffer(uploaded, key), plaintext);
  assert.match(result.artifactName, /^tracegarden\/20260102T030405Z-[a-f0-9]{12}\.dump\.enc$/);
  assert.equal(result.retentionDays, 30);

  let nativeUpload;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    nativeUpload = { url: String(url), options };
    return new Response(null, { status: 200 });
  };
  const signingClock = new Date("2026-01-02T03:04:05.000Z");
  try {
    await runBackup({
      environment: { ...environment, AWS_ACCESS_KEY_ID: "test-access", AWS_SECRET_ACCESS_KEY: "test-secret", AWS_REGION: "us-east-1" },
      dump: async () => plaintext,
      now: signingClock,
    });
    assert.ok(nativeUpload);
    assert.match(nativeUpload.url, /storage\.invalid\/tracegarden-backups\/tracegarden\/20260102T030405Z-/);
    assert.equal(nativeUpload.options.method, "PUT");
    assert.match(nativeUpload.options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=test-access\//);
    assert.equal(nativeUpload.options.headers["x-amz-date"], "20260102T030405Z");
    assert.equal(Object.hasOwn(nativeUpload.options.headers, "x-amz-security-token"), false);
    assert.match(nativeUpload.options.headers["x-amz-content-sha256"], /^[a-f0-9]{64}$/);
    assert.match(nativeUpload.options.headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=/);
    assert.notEqual(Buffer.from(nativeUpload.options.body).includes(plaintext), true, "native uploader must receive encrypted bytes only");

    const vectorBody = Buffer.from("fixture payload\n");
    await writeFile(sigV4VectorPath, vectorBody, { mode: 0o600 });
    const vectorEnvironment = {
      ...environment,
      AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      AWS_REGION: "us-east-1",
      AWS_SESSION_TOKEN: "session-token",
    };
    await uploadWithAws({
      artifactPath: sigV4VectorPath,
      artifactName: "fixtures/vector.dump.enc",
      endpoint: environment.BACKUP_ENDPOINT,
      bucket: environment.BACKUP_BUCKET,
      environment: vectorEnvironment,
      now: signingClock,
    });
    assert.equal(nativeUpload.url, "https://storage.invalid/tracegarden-backups/fixtures/vector.dump.enc");
    assert.deepEqual(Buffer.from(nativeUpload.options.body), vectorBody);
    assert.equal(nativeUpload.options.headers["x-amz-content-sha256"], "565b24bc77ebeee74f70f6c608e099956666c3589ed85146fcea7e77d9f25356");
    assert.equal(nativeUpload.options.headers["x-amz-date"], "20260102T030405Z");
    assert.equal(nativeUpload.options.headers["x-amz-security-token"], "session-token");
    assert.equal(nativeUpload.options.headers.authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260102/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=3c9ed5ee25d7e92ebd224ceea1ad2b2a8a897ee398d453976f14b8cbe5ea748f");

    const vectorAuthorization = nativeUpload.options.headers.authorization;
    await uploadWithAws({
      artifactPath: sigV4VectorPath,
      artifactName: "fixtures/vector-perturbed.dump.enc",
      endpoint: environment.BACKUP_ENDPOINT,
      bucket: environment.BACKUP_BUCKET,
      environment: vectorEnvironment,
      now: signingClock,
    });
    assert.notEqual(nativeUpload.url, "https://storage.invalid/tracegarden-backups/fixtures/vector.dump.enc");
    assert.notEqual(nativeUpload.options.headers.authorization, vectorAuthorization, "canonical path perturbation must change the signature");
    assert.equal(nativeUpload.options.headers["x-amz-content-sha256"], "565b24bc77ebeee74f70f6c608e099956666c3589ed85146fcea7e77d9f25356");
    console.log("offline backup encryption, native SigV4 fixed vector, perturbation, off-VM gate, and credential-free boundary passed");
  } finally {
    globalThis.fetch = originalFetch;
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
