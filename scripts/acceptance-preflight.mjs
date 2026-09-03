import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const postgresImage = "postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7";
const nodeImage = "node:26.8-bookworm@sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89";
const bunImage = "docker.io/oven/bun:1.3.14-slim@sha256:6068a9d40e9fc5c4519891edb63dfc5935c393fe2228eb9a5b7f472b444b5ee2";
const smokeScripts = ["scripts/browser-smoke.mjs", "scripts/postgres-smoke.mjs", "scripts/core-loop-browser.mjs"];
const acceptanceDocs = await readFile("docs/acceptance.md", "utf8");
const compose = await readFile("docker-compose.yml", "utf8");
const containerSmoke = await readFile("scripts/container-smoke.mjs", "utf8");
const containerContext = await readFile("scripts/container-context.mjs", "utf8");
const cleanCachePolicy = await readFile("scripts/container-context-clean-cache.mjs", "utf8");
const cleanCacheBuild = await readFile("scripts/container-clean-cache.mjs", "utf8");
const acceptance = await readFile("scripts/acceptance.mjs", "utf8");
for (const path of ["deploy/docker/web.Dockerfile", "deploy/docker/collector.Dockerfile", "deploy/docker/migrate.Dockerfile"]) {
  const dockerfile = await readFile(path, "utf8");
  assert.match(dockerfile, /COPY --from=frozen \/dist\//, `${path} must consume the generated frozen build context`);
  assert.doesNotMatch(dockerfile, /(?:npm|pnpm) (?:install|add|fetch)/, `${path} must not contact a package registry`);
}
assert.equal((compose.match(/network: none/g) ?? []).length, 3, "application image builds must use network none");
assert.equal((compose.match(/frozen: \$\{TRACEGARDEN_CONTAINER_CONTEXT/g) ?? []).length, 3, "application image builds must use the generated frozen context");
assert.match(containerSmoke, /container-context\.mjs/);
assert.match(containerSmoke, /--pull=false/);
assert.match(containerSmoke, /\"--pull\", \"never\"/);
assert.match(containerContext, /container context requires the frozen/);
assert.match(containerContext, /dist\/apps\/web\/src\/main\.js/);
assert.match(containerContext, /node_modules\/pg/);
assert.match(containerContext, /install\", \"--offline\", \"--prod\"/);
assert.match(containerSmoke, /build\", \"--pull=false\"/);
assert.match(containerSmoke, /up\", \"-d\", \"--pull\", \"never\", \"--no-build\"/);
assert.match(cleanCachePolicy, /--offline/);
assert.match(cleanCachePolicy, /unexpectedly succeeded/);
assert.match(acceptance, /scripts\/container-clean-cache\.mjs/);
for (const required of ["--no-cache", "--network", "none", "--pull=false", "container-context.mjs", "--load", "--pull=never", "--read-only", "pg_dump", "pg_restore", "id", "--version"]) {
  assert.match(cleanCacheBuild, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `clean-cache build must include ${required}`);
}

for (const path of smokeScripts) {
  const source = await readFile(path, "utf8");
  const preflight = source.indexOf("if (!imageAvailable(postgresImage))");
  const dockerRun = source.indexOf('docker("run"');
  const dockerRunEnd = source.indexOf(");", dockerRun);
  assert.ok(source.includes(`const postgresImage = "${postgresImage}";`), `${path} must use the exact pinned PostgreSQL image`);
  assert.match(source, /function imageAvailable\(image\)/, `${path} must inspect the local image store`);
  assert.ok(preflight >= 0 && preflight < dockerRun, `${path} must preflight the image before docker run`);
  assert.match(source.slice(preflight, dockerRun), /refusing to pull it/, `${path} must fail closed instead of pulling`);
  assert.ok(dockerRunEnd > dockerRun, `${path} must have a complete docker run invocation`);
  assert.match(source.slice(dockerRun, dockerRunEnd), /docker\("run",\s*"--pull=never"/, `${path} must disable Docker pulls`);
  assert.doesNotMatch(source, /\bdocker\s+pull\b/, `${path} must not pull from a registry`);
}

assert.ok(acceptanceDocs.includes(`docker image inspect '${postgresImage}'`), "acceptance docs must state the exact PostgreSQL image prerequisite");
assert.ok(acceptanceDocs.includes(`docker image inspect '${nodeImage}'`), "acceptance docs must state the exact Node.js image prerequisite");
assert.ok(acceptanceDocs.includes(`docker image inspect '${bunImage}'`), "acceptance docs must state the exact Bun image prerequisite");
console.log("offline acceptance preflight policy passed: pinned images, network-disabled frozen application builds, and pull-never smoke runs");
