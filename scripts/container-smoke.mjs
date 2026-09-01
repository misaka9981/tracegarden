import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const project = `tracegarden-smoke-${process.pid}`;
const failureProject = `${project}-migration-failure`;
const nodeImage = "node:26.8-bookworm@sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89";
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

if (!imageAvailable(nodeImage) || !imageAvailable(postgresImage)) {
  throw new Error("container smoke requires the pinned Node.js 26 and PostgreSQL images; refusing to report a skipped check as passed");
}

function compose(args, composeProject = project, extraEnvironment = environment) {
  return docker(["compose", "-p", composeProject, ...args], extraEnvironment);
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
    if (docker(["inspect", "-f", "{{.State.Running}}", container]) === "false") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`container did not stop: ${container}`);
}
async function waitForHealthy(container, extraEnvironment) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (docker(["inspect", "-f", "{{.State.Health.Status}}", container], extraEnvironment) === "healthy") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`container did not become healthy: ${container}`);
}

try {
  compose(["up", "-d", "--build"]);
  const migrationContainer = compose(["ps", "-aq", "migrate"]);
  assert.ok(migrationContainer, "the one-shot migration gate must create a container");
  assert.equal(docker(["inspect", "-f", "{{.State.Status}}", migrationContainer]), "exited");
  assert.equal(docker(["inspect", "-f", "{{.State.ExitCode}}", migrationContainer]), "0");

  const webResponse = await waitFor("http://127.0.0.1:3000/health/readiness");
  const collectorResponse = await waitFor("http://127.0.0.1:3001/health/readiness", (response) => response.status === 503);
  assert.equal((await webResponse.json()).status, "ready");
  assert.equal((await collectorResponse.json()).checks.collector, "not-ready");
  assert.equal((await waitFor("http://127.0.0.1:3000/health/startup")).status, 200);
  assert.equal((await waitFor("http://127.0.0.1:3001/health/startup")).status, 200);
  assert.equal((await waitFor("http://127.0.0.1:3000/health/live")).status, 200);
  assert.equal((await waitFor("http://127.0.0.1:3001/health/live")).status, 200);

  const images = {};
  for (const service of ["web", "collector"]) {
    const container = compose(["ps", "-q", service]);
    assert.equal(docker(["inspect", "-f", "{{.Config.User}}", container]), "node");
    assert.match(compose(["exec", "-T", service, "id", "-u"]), /^[1-9]\d*$/);
    assert.match(compose(["exec", "-T", service, "id", "-g"]), /^[1-9]\d*$/);
    assert.equal(docker(["inspect", "-f", "{{.HostConfig.ReadonlyRootfs}}", container]), "true");
    assert.match(docker(["inspect", "-f", "{{json .HostConfig.CapDrop}}", container]), /ALL/);
    assert.match(docker(["inspect", "-f", "{{json .HostConfig.Tmpfs}}", container]), /tmp/);
    const image = docker(["inspect", "-f", "{{.Config.Image}}", container]);
    images[service] = image;
    assert.equal(docker(["image", "inspect", "-f", "{{.Architecture}}", image]), "arm64");
    assert.doesNotMatch(docker(["image", "inspect", "-f", "{{json .Config.Env}}", image]), /GOOGLE|KUBERNETES/);
    assert.match(compose(["exec", "-T", service, "node", "--version"]), /^v26\.8\.\d+$/);
    assert.equal(compose(["exec", "-T", service, "sh", "-c", "test ! -e /app/apps && test ! -e /app/scripts && test ! -e /app/.env && test ! -e /app/node_modules/.pnpm/node_modules/.bin && test ! -e /app/node_modules/.pnpm/node_modules/@typescript"]), "");
    assert.equal(expectFailure(["compose", "-p", project, "exec", "-T", service, "sh", "-c", "touch /app/.write-test"]), true);
    assert.equal(compose(["exec", "-T", service, "sh", "-c", "touch /tmp/.write-test && rm /tmp/.write-test"]), "");
    if (service === "collector") assert.doesNotMatch(docker(["inspect", "-f", "{{json .Config.Env}}", container]), /GOOGLE|KUBERNETES/);
    assert.doesNotMatch(docker(["logs", container]), /local-container-only|local-container-smoke|local-container-timeline/);
  }

  const collector = compose(["ps", "-q", "collector"]);
  assert.equal((await fetch("http://127.0.0.1:3001/health/readiness")).status, 503);
  assert.equal(JSON.parse(docker(["inspect", "-f", "{{json .Config.Env}}", collector])).some((value) => value.startsWith("KUBERNETES_")), false);
  assert.equal(expectFailure(["run", "--rm", images.web]), true, "web must reject missing production configuration");
  assert.equal(expectFailure(["run", "--rm", images.collector]), true, "collector must reject missing production configuration");

  for (const service of ["web", "collector"]) {
    const container = compose(["ps", "-q", service]);
    docker(["kill", "--signal", "TERM", container]);
    await waitForStopped(container);
    assert.equal(docker(["inspect", "-f", "{{.State.ExitCode}}", container]), "0");
  }
  assert.match(compose(["logs", "--no-color", "web", "collector"]), /web\.stopping|collector\.stopping/);

  compose(["down", "-v"]);
  const failureEnvironment = {
    ...environment,
    COMPOSE_PROJECT_NAME: failureProject,
    MIGRATION_DATABASE_URL: "postgresql://tracegarden:local-only@postgres:5432/does-not-exist",
  };
  try {
    compose(["up", "-d", "postgres"], failureProject, failureEnvironment);
    const failurePostgres = compose(["ps", "-q", "postgres"], failureProject, failureEnvironment);
    assert.ok(failurePostgres, "the migration failure test must create PostgreSQL");
    await waitForHealthy(failurePostgres, failureEnvironment);
    compose(["exec", "-T", "postgres", "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", "CREATE TABLE tracegarden_schema_migrations (id text PRIMARY KEY, applied_at text NOT NULL);"], failureProject, failureEnvironment);
    expectFailure(["compose", "-p", failureProject, "up", "-d", "--build"], failureEnvironment);
    const failedMigration = compose(["ps", "-aq", "migrate"], failureProject, failureEnvironment);
    assert.ok(failedMigration, "the failed migration gate must create a container");
    assert.notEqual(docker(["inspect", "-f", "{{.State.ExitCode}}", failedMigration], failureEnvironment), "0");
    for (const service of ["web", "collector"]) {
      assert.equal(compose(["ps", "-q", service], failureProject, failureEnvironment), "", `${service} must not start when migrations fail`);
      await assert.rejects(fetch(`http://127.0.0.1:${service === "web" ? 3000 : 3001}/health/readiness`), `${service} must not become ready when migrations fail`);
    }
  } finally {
    try { compose(["down", "-v"], failureProject, failureEnvironment); } catch { /* preserve the original failure */ }
  }
  console.log("ARM64 Node 26.8.x non-root read-only web, collector, migration gate, and lifecycle smoke passed");
} finally {
  try { compose(["down", "-v"]); } catch { /* preserve the original failure */ }
}
