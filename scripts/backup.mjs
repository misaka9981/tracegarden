import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BACKUP_FORMAT = "tracegarden-postgresql-backup-v1";
const CREDENTIAL_QUERY_PARAMETER = /(?:password|pass|secret|token|credential|accesskey|apikey|privatekey|sslkey|signature|authorization|auth)/i;
const CREDENTIAL_QUERY_ASSIGNMENT = /(?:password|pass|secret|token|credential|accesskey|apikey|privatekey|sslkey|signature|authorization|auth)\s*=/i;
const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;
const ENVELOPE_SEPARATOR = "\n";
export const BACKUP_OPERATION_TIMEOUT_MS = 30_000;
const PG_DUMP_KILL_GRACE_MS = 250;
const OBJECT_STORAGE_ENDPOINT_PATTERN = /^https:\/\/([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?(\/[^\s?#]*)?$/;

function requiredValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`missing backup configuration: ${name}`);
  return value;
}

export function safePostgresDatabaseUrl(databaseUrl, name = "DATABASE_URL") {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
    if (!/^postgres(?:ql):$/i.test(parsed.protocol) || !parsed.hostname) throw new Error("unsupported PostgreSQL URL");
    if (parsed.hash || [...parsed.searchParams.entries()].some(([key, value]) => CREDENTIAL_QUERY_PARAMETER.test(key)
      || (key.toLowerCase() === "options" && CREDENTIAL_QUERY_ASSIGNMENT.test(value)))) {
      throw new Error("credential-bearing URL component");
    }
    const password = decodeURIComponent(parsed.password);
    parsed.password = "";
    return { url: parsed.toString(), password };
  } catch (error) {
    if (error instanceof Error && error.message === "credential-bearing URL component") {
      throw new Error(`${name} must not contain credential-bearing query parameters or fragments`);
    }
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
}

function safeObjectStorageEndpoint(endpoint) {
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error("BACKUP_ENDPOINT must be a valid HTTPS URL");
  }
  if (parsedEndpoint.protocol !== "https:" || parsedEndpoint.username || parsedEndpoint.password) {
    throw new Error("BACKUP_ENDPOINT must be an HTTPS URL without embedded credentials");
  }
  if (parsedEndpoint.search || parsedEndpoint.hash) {
    throw new Error("BACKUP_ENDPOINT must not contain query parameters or fragments");
  }
  if (!OBJECT_STORAGE_ENDPOINT_PATTERN.test(endpoint)) {
    throw new Error("BACKUP_ENDPOINT must be a valid HTTPS URL");
  }
  return parsedEndpoint.toString();
}

export function validateBackupConfiguration(environment = process.env, { requireCredentials = false } = {}) {
  const databaseUrl = requiredValue(environment, "DATABASE_URL");
  if (!/^postgres(?:ql):\/\//i.test(databaseUrl)) throw new Error("DATABASE_URL must be a PostgreSQL URL");
  safePostgresDatabaseUrl(databaseUrl);
  const endpoint = safeObjectStorageEndpoint(requiredValue(environment, "BACKUP_ENDPOINT"));
  const bucket = requiredValue(environment, "BACKUP_BUCKET");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("BACKUP_BUCKET must be an object-storage bucket name");
  const schedule = requiredValue(environment, "BACKUP_SCHEDULE");
  const retentionDays = Number(requiredValue(environment, "BACKUP_RETENTION_DAYS"));
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error("BACKUP_RETENTION_DAYS must be a positive integer");
  if (requiredValue(environment, "BACKUP_DESTINATION_SCOPE") !== "off-vm") throw new Error("backup destination must be off-VM");
  if (requiredValue(environment, "BACKUP_CREDENTIALS_SOURCE").startsWith("kubernetes-secret/") === false) {
    throw new Error("BACKUP_CREDENTIALS_SOURCE must identify a Kubernetes Secret");
  }
  if (requiredValue(environment, "BACKUP_ENCRYPTION_MECHANISM") !== "aes-256-gcm") {
    throw new Error("BACKUP_ENCRYPTION_MECHANISM must be aes-256-gcm");
  }
  const keyFile = requiredValue(environment, "BACKUP_ENCRYPTION_KEY_FILE");
  if (requireCredentials && (!environment.AWS_ACCESS_KEY_ID?.trim() || !environment.AWS_SECRET_ACCESS_KEY?.trim())) {
    throw new Error("object-storage credentials are unavailable from the configured Secret");
  }
  return { databaseUrl, endpoint, bucket, schedule, retentionDays, keyFile };
}

export function decodeEncryptionKey(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8").trim() : String(value).trim();
  if (/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, "hex");
  const decoded = Buffer.from(text, "base64");
  if (decoded.length === AES_KEY_BYTES && decoded.toString("base64").replace(/=+$/, "") === text.replace(/=+$/, "")) return decoded;
  throw new Error("backup encryption key must be a 32-byte hexadecimal or base64 value");
}

export function encryptBackupBuffer(plaintext, key) {
  const encryptionKey = Buffer.isBuffer(key) ? key : decodeEncryptionKey(key);
  if (encryptionKey.length !== AES_KEY_BYTES) throw new Error("backup encryption key must be 32 bytes");
  const iv = randomBytes(AES_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const header = Buffer.from(`${JSON.stringify({
    format: BACKUP_FORMAT,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
  })}${ENVELOPE_SEPARATOR}`);
  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
}

export function decryptBackupBuffer(artifact, key) {
  const separator = artifact.indexOf(ENVELOPE_SEPARATOR);
  if (separator < 1 || artifact.length <= separator + 1 + 16) throw new Error("backup artifact envelope is invalid");
  let header;
  try {
    header = JSON.parse(artifact.subarray(0, separator).toString("utf8"));
  } catch {
    throw new Error("backup artifact envelope is invalid");
  }
  if (header.format !== BACKUP_FORMAT || header.algorithm !== "aes-256-gcm") throw new Error("backup artifact encryption is unsupported");
  const iv = Buffer.from(header.iv, "base64");
  if (iv.length !== AES_IV_BYTES) throw new Error("backup artifact initialization vector is invalid");
  const encryptionKey = Buffer.isBuffer(key) ? key : decodeEncryptionKey(key);
  if (encryptionKey.length !== AES_KEY_BYTES) throw new Error("backup encryption key must be 32 bytes");
  const ciphertextEnd = artifact.length - 16;
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(artifact.subarray(ciphertextEnd));
  try {
    return Buffer.concat([decipher.update(artifact.subarray(separator + 1, ciphertextEnd)), decipher.final()]);
  } catch {
    throw new Error("backup artifact integrity check failed");
  }
}

async function readEncryptionKey(keyFile) {
  return decodeEncryptionKey(await readFile(keyFile));
}

function databaseProcessEnvironment(databaseUrl, environment) {
  const safe = safePostgresDatabaseUrl(databaseUrl);
  return {
    environment: {
      ...environment,
      PGPASSWORD: safe.password,
    },
    safeUrl: safe.url,
  };
}

function boundedTimeout(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : BACKUP_OPERATION_TIMEOUT_MS;
}

function runPgDump(databaseUrl, environment, { timeoutMs = BACKUP_OPERATION_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const connection = databaseProcessEnvironment(databaseUrl, environment);
    let child;
    try {
      child = spawn("pg_dump", ["--format=custom", "--no-password", `--dbname=${connection.safeUrl}`], {
        env: connection.environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(new Error("pg_dump could not be started"));
      return;
    }
    const output = [];
    const timeout = boundedTimeout(timeoutMs);
    let timedOut = false;
    let timeoutHandle;
    let killHandle;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(killHandle);
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = () => {
      if (settled || child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      child.kill("SIGTERM");
      killHandle = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, PG_DUMP_KILL_GRACE_MS);
    };
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.resume();
    child.once("error", () => finish(new Error(timedOut ? "pg_dump timed out" : "pg_dump could not be started")));
    child.once("close", (code) => {
      if (timedOut) finish(new Error("pg_dump timed out"));
      else if (code === 0) finish(null, Buffer.concat(output));
      else finish(new Error("pg_dump failed"));
    });
    timeoutHandle = setTimeout(terminate, timeout);
  });
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function canonicalPath(path) {
  return path.split("/").map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join("/") || "/";
}

async function uploadWithAws({ artifactPath, endpoint, bucket, artifactName, environment, now = new Date(), timeoutMs = BACKUP_OPERATION_TIMEOUT_MS }) {
  const accessKey = environment.AWS_ACCESS_KEY_ID?.trim();
  const secretKey = environment.AWS_SECRET_ACCESS_KEY?.trim();
  if (!accessKey || !secretKey) throw new Error("object-storage credentials are unavailable from the configured Secret");
  const body = await readFile(artifactPath);
  const endpointUrl = new URL(safeObjectStorageEndpoint(endpoint));
  endpointUrl.pathname = `${endpointUrl.pathname.replace(/\/$/, "")}/${bucket}/${artifactName}`;
  const payloadHash = createHash("sha256").update(body).digest("hex");
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const region = environment.AWS_REGION?.trim() || environment.AWS_DEFAULT_REGION?.trim() || "us-east-1";
  const headers = {
    host: endpointUrl.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(environment.AWS_SESSION_TOKEN?.trim() ? { "x-amz-security-token": environment.AWS_SESSION_TOKEN.trim() } : {}),
  };
  const canonicalHeaders = Object.entries(headers).sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value.trim()}`).join("\n");
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalRequest = `PUT\n${canonicalPath(endpointUrl.pathname)}\n\n${canonicalHeaders}\n\n${signedHeaders}\n${payloadHash}`;
  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), "s3"), "aws4_request");
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${createHmac("sha256", signingKey).update(stringToSign).digest("hex")}`;
  const timeout = boundedTimeout(timeoutMs);
  const controller = new AbortController();
  let timeoutHandle;
  let rejectTimeout = () => {};
  const timeoutPromise = new Promise((_, reject) => { rejectTimeout = reject; });
  let fetchPromise;
  try {
    fetchPromise = fetch(endpointUrl, {
      method: "PUT",
      headers: { ...headers, authorization },
      body,
      signal: controller.signal,
    });
  } catch {
    throw new Error("encrypted backup upload failed");
  }
  timeoutHandle = setTimeout(() => {
    controller.abort();
    rejectTimeout(new Error("encrypted backup upload timed out"));
  }, timeout);
  try {
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    if (controller.signal.aborted) throw new Error("encrypted backup upload timed out");
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => undefined);
      throw new Error("encrypted backup upload failed");
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error("encrypted backup upload timed out");
    if (error instanceof Error && error.message === "encrypted backup upload failed") throw error;
    throw new Error("encrypted backup upload failed");
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function artifactName(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `tracegarden/${timestamp}-${randomBytes(6).toString("hex")}.dump.enc`;
}

export async function runBackup({ environment = process.env, dump = null, upload = uploadWithAws, now = new Date(), timeoutMs = BACKUP_OPERATION_TIMEOUT_MS } = {}) {
  const configuration = validateBackupConfiguration(environment, { requireCredentials: !dump || upload === uploadWithAws });
  const key = await readEncryptionKey(configuration.keyFile);
  const directory = await mkdtemp(join(tmpdir(), "tracegarden-backup-"));
  try {
    const plaintext = dump
      ? await dump(configuration.databaseUrl, environment)
      : await runPgDump(configuration.databaseUrl, environment, { timeoutMs });
    if (!Buffer.isBuffer(plaintext)) throw new Error("pg_dump did not produce a byte artifact");
    const encrypted = encryptBackupBuffer(plaintext, key);
    const path = join(directory, "backup.dump.enc");
    const name = artifactName(now);
    await writeFile(path, encrypted, { mode: 0o600 });
    const uploadRequest = { artifactPath: path, artifactName: name, endpoint: configuration.endpoint, bucket: configuration.bucket, retentionDays: configuration.retentionDays };
    if (upload === uploadWithAws) await uploadWithAws({ ...uploadRequest, environment, now, timeoutMs });
    else await upload(uploadRequest);
    return { artifactName: name, encryptedBytes: encrypted.length, retentionDays: configuration.retentionDays };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function main(environment = process.env) {
  try {
    const result = await runBackup({ environment });
    console.log(JSON.stringify({ event: "backup.completed", ...result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const safeMessage = /^(missing backup configuration: [A-Z0-9_]+|DATABASE_URL must (?:be (?:a PostgreSQL URL|a valid PostgreSQL URL)|not contain credential-bearing query parameters(?: or fragments)?)|BACKUP_ENDPOINT must (?:be (?:a valid HTTPS URL|an HTTPS URL without embedded credentials)|not contain query parameters or fragments)|BACKUP_BUCKET must be an object-storage bucket name|BACKUP_RETENTION_DAYS must be a positive integer|backup destination must be off-VM|BACKUP_CREDENTIALS_SOURCE must identify a Kubernetes Secret|BACKUP_ENCRYPTION_MECHANISM must be aes-256-gcm|object-storage credentials are unavailable from the configured Secret|backup encryption key must be a 32-byte hexadecimal or base64 value|backup encryption key must be 32 bytes|pg_dump (?:could not be started|failed|timed out)|object-storage uploader could not be started|encrypted backup upload (?:failed|timed out)|pg_dump did not produce a byte artifact)$/.test(message)
      ? message
      : "unexpected backup process failure";
    console.error(`backup failed: ${safeMessage}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

export { runPgDump, uploadWithAws };
