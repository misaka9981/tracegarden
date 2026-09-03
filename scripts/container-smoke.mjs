import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { isStoppedContainerStatus } from "./container-state.mjs";

const project = process.env.CONTAINER_SMOKE_PROJECT?.trim() || `tracegarden-smoke-${process.pid}`;
const backupSmoke = process.env.CONTAINER_SMOKE_BACKUP === "1";
const invalidUrlProject = `${project}-invalid-url`;
const schemaFailureProject = `${project}-schema-failure`;
const bunImage = "docker.io/oven/bun:1.4.0-distroless@sha256:76caa97ddc0e01333d98c6ab5499539dad4bbceae6237eac83e7853d3826b981";
const bunUser = "nonroot";
const bunVersion = "1.4.0";
const noNodeRuntime = "const fs=process.getBuiltinModule('node:fs'); if (fs.existsSync('/usr/local/bin/node') || Bun.which('node')) process.exit(1)";
const noProductionFiles = "const fs=process.getBuiltinModule('node:fs'); if (fs.existsSync('/app/apps') || fs.existsSync('/app/scripts') || fs.existsSync('/app/.env') || fs.existsSync('/app/node_modules/.pnpm/node_modules/.bin') || fs.existsSync('/app/node_modules/.pnpm/node_modules/@typescript')) process.exit(1)";
const bunIdentity = "console.log(process.getuid(), process.getgid())";
const postgresImage = "postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7";
const environment = { ...process.env, COMPOSE_PROJECT_NAME: project, POSTGRES_PORT: "0" };

function docker(args, extraEnvironment = environment) {
  return execFileSync("docker", args, { encoding: "utf8", env: extraEnvironment, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function imageAvailable(image) {
  try {
    docker(["image", "inspect", image]);
    return true;
  } catch {
    return false;
  }
}
function expectFailure(args, extraEnvironment = environment) {
  try {
    docker(args, extraEnvironment);
    return false;
  } catch {
    return true;
  }
}

if (!imageAvailable(bunImage) || !imageAvailable(postgresImage)) {
  throw new Error("container smoke requires the pinned Bun and PostgreSQL images; refusing to report a skipped check as passed");
}

function compose(args, composeProject = project, extraEnvironment = environment) {
  return docker(["compose", "-p", composeProject, ...args], extraEnvironment);
}

if (process.env.CONTAINER_SMOKE_NO_BUILD !== "1") {
  execFileSync(process.execPath, ["scripts/container-context.mjs"], { stdio: "inherit", env: environment });
  compose(["build", "--pull=false"]);
}
async function waitFor(url, ready = (response) => response.ok) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (ready(response)) return response;
    } catch {
      // The service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`service did not become ready: ${url}`);
}
async function waitForStopped(container) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const [status, startedAt] = docker(["inspect", "-f", "{{.State.Status}} {{.State.StartedAt}}", container]).split(/\s+/, 2);
    if (isStoppedContainerStatus(status) && startedAt && !startedAt.startsWith("0001-01-01T00:00:00")) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`container did not stop after a started run: ${container}`);
}
async function waitForLogMatch(readLogs, label, pattern) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const logs = readLogs();
    if (pattern.test(logs)) return logs;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`container logs did not contain expected output: ${label}`);
}
async function waitForHealthy(container, extraEnvironment) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (docker(["inspect", "-f", "{{.State.Health.Status}}", container], extraEnvironment) === "healthy") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`container did not become healthy: ${container}`);
}

try {
  compose(["up", "-d", "--pull", "never", "--no-build"]);
  const migrationContainer = compose(["ps", "-aq", "migrate"]);
  assert.ok(migrationContainer, "the one-shot migration gate must create a container");
  assert.equal(docker(["inspect", "-f", "{{.State.Status}}", migrationContainer]), "exited");
  assert.equal(docker(["inspect", "-f", "{{.State.ExitCode}}", migrationContainer]), "0");
  const imageIds = {
    migrate: docker(["inspect", "-f", "{{.Image}}", migrationContainer]),
  };
  assert.equal(docker(["inspect", "-f", "{{.Config.User}}", migrationContainer]), bunUser);
  assert.equal(docker(["inspect", "-f", "{{.HostConfig.ReadonlyRootfs}}", migrationContainer]), "true");
  assert.match(docker(["inspect", "-f", "{{json .HostConfig.CapDrop}}", migrationContainer]), /ALL/);
  assert.match(docker(["inspect", "-f", "{{json .HostConfig.Tmpfs}}", migrationContainer]), /tmp/);
  assert.match(docker(["inspect", "-f", "{{json .HostConfig.SecurityOpt}}", migrationContainer]), /no-new-privileges:true/);
  assert.equal(docker(["image", "inspect", "-f", "{{.Architecture}}", imageIds.migrate]), "arm64");
  assert.match(docker(["run", "--rm", "--pull=never", "--platform", "linux/arm64", "--read-only", "--user", bunUser, "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--cap-drop", "ALL", "--entrypoint", "bun", imageIds.migrate, "--eval", bunIdentity]), /^[1-9]\d* [1-9]\d*$/);
  assert.equal(docker(["run", "--rm", "--pull=never", "--platform", "linux/arm64", "--read-only", "--user", bunUser, "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--cap-drop", "ALL", "--entrypoint", "bun", imageIds.migrate, "--version"]), bunVersion);
  assert.equal(docker(["run", "--rm", "--pull=never", "--platform", "linux/arm64", "--read-only", "--user", bunUser, "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--cap-drop", "ALL", "--entrypoint", "bun", imageIds.migrate, "--eval", noNodeRuntime]), "");

  const webResponse = await waitFor("http://127.0.0.1:3000/health/readiness");
  const collectorResponse = await waitFor("http://127.0.0.1:3001/health/readiness", (response) => response.status === 503);
  assert.equal((await webResponse.json()).status, "ready");
  assert.equal((await collectorResponse.json()).checks.collector, "not-ready");
  assert.equal((await waitFor("http://127.0.0.1:3000/health/startup")).status, 200);
  assert.equal((await waitFor("http://127.0.0.1:3001/health/startup")).status, 200);
  assert.equal((await waitFor("http://127.0.0.1:3000/health/live")).status, 200);
  assert.equal((await waitFor("http://127.0.0.1:3001/health/live")).status, 200);

  for (const service of ["web", "collector"]) {
    const container = compose(["ps", "-q", service]);
    assert.equal(docker(["inspect", "-f", "{{.Config.User}}", container]), bunUser);
    assert.match(compose(["exec", "-T", service, "bun", "--eval", bunIdentity]), /^[1-9]\d* [1-9]\d*$/);
    assert.equal(docker(["inspect", "-f", "{{.HostConfig.ReadonlyRootfs}}", container]), "true");
    assert.match(docker(["inspect", "-f", "{{json .HostConfig.CapDrop}}", container]), /ALL/);
    assert.match(docker(["inspect", "-f", "{{json .HostConfig.Tmpfs}}", container]), /tmp/);
    const imageId = docker(["inspect", "-f", "{{.Image}}", container]);
    imageIds[service] = imageId;
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(docker(["image", "inspect", "-f", "{{.Architecture}}", imageId]), "arm64");
    assert.doesNotMatch(docker(["image", "inspect", "-f", "{{json .Config.Env}}", imageId]), /GOOGLE|KUBERNETES/);
    assert.equal(compose(["exec", "-T", service, "bun", "--version"]), bunVersion);
    assert.equal(compose(["exec", "-T", service, "bun", "--eval", noNodeRuntime]), "");
    assert.equal(compose(["exec", "-T", service, "bun", "--eval", noProductionFiles]), "");
    assert.equal(expectFailure(["compose", "-p", project, "exec", "-T", service, "bun", "--eval", "process.getBuiltinModule('node:fs').writeFileSync('/app/.write-test','x')"]), true);
    assert.equal(compose(["exec", "-T", service, "bun", "--eval", "const fs=process.getBuiltinModule('node:fs'); fs.writeFileSync('/tmp/.write-test','x'); fs.unlinkSync('/tmp/.write-test')"]), "");
    if (service === "collector") assert.doesNotMatch(docker(["inspect", "-f", "{{json .Config.Env}}", container]), /GOOGLE|KUBERNETES/);
    assert.doesNotMatch(docker(["logs", container]), /local-container-only|local-container-smoke|local-container-timeline/);
  }

  if (backupSmoke) {
    const backupContainer = compose(["ps", "-aq", "backup"]);
    assert.ok(backupContainer, "the exact release backup image must create a container");
    await waitForStopped(backupContainer);
    assert.notEqual(docker(["inspect", "-f", "{{.State.ExitCode}}", backupContainer]), "0", "backup must fail closed without backup configuration");
    assert.equal(docker(["inspect", "-f", "{{.Config.User}}", backupContainer]), bunUser);
    assert.equal(docker(["inspect", "-f", "{{.HostConfig.ReadonlyRootfs}}", backupContainer]), "true");
    assert.match(docker(["inspect", "-f", "{{json .HostConfig.CapDrop}}", backupContainer]), /ALL/);
    assert.match(docker(["inspect", "-f", "{{json .HostConfig.Tmpfs}}", backupContainer]), /tmp/);
    const backupImageId = docker(["inspect", "-f", "{{.Image}}", backupContainer]);
    assert.match(backupImageId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(docker(["image", "inspect", "-f", "{{.Architecture}}", backupImageId]), "arm64");
    assert.equal(docker(["run", "--rm", "--pull=never", "--entrypoint", "pg_dump", backupImageId, "--version"]), "pg_dump (PostgreSQL) 18.3");
    assert.equal(docker(["run", "--rm", "--pull=never", "--entrypoint", "pg_restore", backupImageId, "--version"]), "pg_restore (PostgreSQL) 18.3");
    assert.equal(docker(["run", "--rm", "--pull=never", "--user", bunUser, "--entrypoint", "bun", backupImageId, "--eval", noNodeRuntime]), "");
    assert.doesNotMatch(docker(["inspect", "-f", "{{json .Config.Env}}", backupContainer]), /AWS_ACCESS_KEY|AWS_SECRET_ACCESS_KEY|BACKUP_ENCRYPTION/);
    await waitForLogMatch(() => compose(["logs", "--no-color", "backup"]), "backup", /missing backup configuration: DATABASE_URL/);
  }

  const collector = compose(["ps", "-q", "collector"]);
  assert.equal((await fetch("http://127.0.0.1:3001/health/readiness")).status, 503);
  assert.equal(JSON.parse(docker(["inspect", "-f", "{{json .Config.Env}}", collector])).some((value) => value.startsWith("KUBERNETES_")), false);
  assert.equal(expectFailure(["run", "--rm", imageIds.web]), true, "web must reject missing production configuration");
  assert.equal(expectFailure(["run", "--rm", imageIds.collector]), true, "collector must reject missing production configuration");

  for (const service of ["web", "collector"]) {
    const container = compose(["ps", "-q", service]);
    docker(["kill", "--signal", "TERM", container]);
    await waitForStopped(container);
    assert.equal(docker(["inspect", "-f", "{{.State.ExitCode}}", container]), "0");
  }
  assert.match(compose(["logs", "--no-color", "web", "collector"]), /web\.stopping|collector\.stopping/);

  compose(["down", "-v"]);
  async function assertMigrationFailure(failureProject, migrationDatabaseUrl, prepareSchema, expectedError) {
    const failureEnvironment = {
      ...environment,
      COMPOSE_PROJECT_NAME: failureProject,
      MIGRATION_DATABASE_URL: migrationDatabaseUrl,
      MIGRATION_DATABASE_READY_TIMEOUT_SECONDS: "1",
      MIGRATION_DATABASE_READY_RETRY_SECONDS: "1",
    };
    try {
      compose(["up", "-d", "--pull", "never", "--no-build", "postgres"], failureProject, failureEnvironment);
      const failurePostgres = compose(["ps", "-q", "postgres"], failureProject, failureEnvironment);
      assert.ok(failurePostgres, "the migration failure test must create PostgreSQL");
      await waitForHealthy(failurePostgres, failureEnvironment);
      if (prepareSchema) {
        compose(["exec", "-T", "postgres", "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", prepareSchema], failureProject, failureEnvironment);
      }
      if (process.env.CONTAINER_SMOKE_NO_BUILD !== "1") compose(["build", "--pull=false"], failureProject, failureEnvironment);
      try { compose(["up", "-d", "--pull", "never", "--no-build"], failureProject, failureEnvironment); } catch { /* expected one-shot migration failure */ }
      const failedMigration = compose(["ps", "-aq", "migrate"], failureProject, failureEnvironment);
      assert.ok(failedMigration, "the failed migration gate must create a container");
      await waitForStopped(failedMigration);
      assert.notEqual(docker(["inspect", "-f", "{{.State.ExitCode}}", failedMigration], failureEnvironment), "0");
      assert.match(compose(["logs", "--no-color", "migrate"], failureProject, failureEnvironment), expectedError);
      for (const service of ["web", "collector"]) {
        assert.equal(compose(["ps", "-q", service], failureProject, failureEnvironment), "", `${service} must not start when migrations fail`);
        await assert.rejects(fetch(`http://127.0.0.1:${service === "web" ? 3000 : 3001}/health/readiness`), `${service} must not become ready when migrations fail`);
      }
    } finally {
      try { compose(["down", "-v"], failureProject, failureEnvironment); } catch { /* preserve the original failure */ }
    }
  }
  await assertMigrationFailure(invalidUrlProject, "not-a-postgresql-url", undefined, /DATABASE_URL must be a valid PostgreSQL URL/);
  await assertMigrationFailure(
    schemaFailureProject,
    "postgresql://tracegarden:local-only@postgres:5432/tracegarden",
    "CREATE TABLE tracegarden_schema_migrations (id text PRIMARY KEY, applied_at text NOT NULL);",
    /Tracegarden database migration failed/,
  );
  const imageFile = process.env.CONTAINER_SMOKE_IMAGE_FILE?.trim();
  if (imageFile) await writeFile(imageFile, `${Object.entries(imageIds).map(([service, imageId]) => `${service}=${imageId}`).join("\n")}\n`);
  console.log("ARM64 Bun 1.4.0 web, collector, and migration non-root read-only, migration gate, invalid-URL, and schema-failure smoke passed");
} finally {
  try { compose(["down", "-v"]); } catch { /* preserve the original failure */ }
}
