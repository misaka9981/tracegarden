import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const project = `tracegarden-smoke-${process.pid}`;
const environment = { ...process.env, COMPOSE_PROJECT_NAME: project, POSTGRES_PORT: "0" };

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function imageAvailable(image) {
  try {
    docker(["image", "inspect", image]);
    return true;
  } catch {
    return false;
  }
}

if (!imageAvailable("node:26.8-bookworm") || !imageAvailable("postgres:18.3-alpine")) {
  throw new Error("container smoke requires the pinned Node.js 26 and PostgreSQL images; refusing to report a skipped check as passed");
}

function compose(args) {
  return docker(["compose", "-p", project, ...args]);
}
async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`service did not become ready: ${url}`);
}

try {
  compose(["up", "-d", "--build"]);
  const webResponse = await waitFor("http://127.0.0.1:3000/health/readiness");
  const collectorResponse = await waitFor("http://127.0.0.1:3001/health/readiness");
  assert.equal((await webResponse.json()).status, "ready");
  assert.equal((await collectorResponse.json()).status, "ready");
  for (const service of ["web", "collector"]) {
    const container = compose(["ps", "-q", service]);
    assert.equal(docker(["inspect", "-f", "{{.Config.User}}", container]), "node");
    const image = docker(["inspect", "-f", "{{.Config.Image}}", container]);
    assert.equal(docker(["image", "inspect", "-f", "{{.Architecture}}", image]), "arm64");
    assert.match(compose(["exec", "-T", service, "node", "--version"]), /^v26\.8\.\d+$/);
  }
  assert.match(compose(["exec", "-T", "postgres", "postgres", "--version"]), /\(PostgreSQL\) 18\.3/);
  console.log("ARM64 Node 26.8.x non-root web and collector container smoke passed");
} finally {
  try { compose(["down", "-v"]); } catch { /* preserve the original failure */ }
}
