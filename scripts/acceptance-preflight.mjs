import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const postgresImage = "postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7";
const bunImage = "docker.io/oven/bun:1.4.0-distroless@sha256:76caa97ddc0e01333d98c6ab5499539dad4bbceae6237eac83e7853d3826b981";
const smokeScripts = ["scripts/browser-smoke.mjs", "scripts/postgres-smoke.mjs", "scripts/core-loop-browser.mjs"];
const acceptanceDocs = await readFile("docs/acceptance.md", "utf8");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const workflow = await readFile(".github/workflows/ci.yml", "utf8");
const compose = await readFile("docker-compose.yml", "utf8");
const webCompose = compose.slice(compose.indexOf("  web:\n"), compose.indexOf("  collector:\n"));
assert.match(webCompose, /\n    user: nonroot\n/);
const containerSmoke = await readFile("scripts/container-smoke.mjs", "utf8");
const containerContext = await readFile("scripts/container-context.mjs", "utf8");
const cleanCachePolicy = await readFile("scripts/container-context-clean-cache.mjs", "utf8");
const cleanCacheBuild = await readFile("scripts/container-clean-cache.mjs", "utf8");
const acceptance = await readFile("scripts/acceptance.mjs", "utf8");
assert.doesNotMatch(workflow, /NODE_IMAGE|node:26-bookworm/, "production container workflow must not require a Node runtime image");
for (const path of ["deploy/docker/web.Dockerfile", "deploy/docker/collector.Dockerfile", "deploy/docker/migrate.Dockerfile"]) {
  const dockerfile = await readFile(path, "utf8");
  assert.match(dockerfile, /COPY --from=frozen \/dist\//, `${path} must consume the generated frozen build context`);
  assert.doesNotMatch(dockerfile, /(?:npm|pnpm) (?:install|add|fetch)/, `${path} must not contact a package registry`);
}
const webDockerfile = await readFile("deploy/docker/web.Dockerfile", "utf8");
assert.ok(webDockerfile.startsWith(`FROM ${bunImage}\n`), "web must use the pinned Bun base image");
assert.match(webDockerfile, /USER nonroot/);
assert.match(webDockerfile, /CMD \["dist\/apps\/web\/src\/bun\.js"\]/);
assert.doesNotMatch(webDockerfile, /node:26|USER node|CMD \["node"|dist\/apps\/web\/src\/main\.js/i, "web image must not retain a Node runtime or fallback");
const collectorDockerfile = await readFile("deploy/docker/collector.Dockerfile", "utf8");
assert.ok(collectorDockerfile.startsWith(`FROM ${bunImage}\n`), "collector must use the pinned Bun base image");
assert.match(collectorDockerfile, /USER nonroot/);
assert.match(collectorDockerfile, /CMD \["dist\/apps\/collector\/src\/main\.js"\]/);
assert.doesNotMatch(collectorDockerfile, /node:26|USER node|CMD \["node"/i, "collector image must not retain a Node runtime");
const migrateDockerfile = await readFile("deploy/docker/migrate.Dockerfile", "utf8");
assert.ok(migrateDockerfile.startsWith(`FROM ${bunImage}\n`), "migration image must use the pinned Bun base image");
assert.match(migrateDockerfile, /USER nonroot/);
assert.match(migrateDockerfile, /CMD \["dist\/apps\/migrate\/src\/main\.js"\]/);
assert.doesNotMatch(migrateDockerfile, /node:26|USER node|CMD \["node"/i, "migration image must not retain a Node runtime");
const backupDockerfile = await readFile("deploy/docker/backup.Dockerfile", "utf8");
assert.ok(backupDockerfile.includes(`FROM ${bunImage}`), "backup must use the pinned Bun base image");
assert.match(backupDockerfile, /USER nonroot/);
assert.match(backupDockerfile, /ENTRYPOINT \["bun", "\/app\/backup\.mjs"\]/);
assert.doesNotMatch(backupDockerfile, /node:26|USER node|ENTRYPOINT \["node"/i, "backup image must not retain a Node runtime");
assert.match(backupDockerfile, /PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/);
assert.doesNotMatch(backupDockerfile, /bun-node-fallback-bin/, "distroless backup image must not retain Bun's Node fallback");
assert.match(backupDockerfile, /COPY --from=postgres-runtime \/usr\/local\/bin\/pg_dump/);
assert.match(backupDockerfile, /COPY --from=postgres-runtime \/usr\/local\/bin\/pg_restore/);
const deployment = await readFile("deploy/chart/templates/deployments.yaml", "utf8");
const webDeployment = deployment.slice(0, deployment.indexOf("\n---"));
assert.ok(webDeployment.includes('command: ["bun", "--input-type=module", "--eval"]'));
assert.equal((compose.match(/network: none/g) ?? []).length, 3, "application image builds must use network none");
assert.equal((compose.match(/frozen: \$\{TRACEGARDEN_CONTAINER_CONTEXT/g) ?? []).length, 3, "application image builds must use the generated frozen context");
assert.match(containerSmoke, /container-context\.mjs/);
assert.match(containerSmoke, /--pull=false/);
assert.match(containerSmoke, /\"--pull\", \"never\"/);
assert.match(containerContext, /container context requires the frozen/);
assert.doesNotMatch(containerContext, /dist\/apps\/web\/src\/main\.js/);
assert.match(containerContext, /node_modules\/pg/);
assert.match(containerContext, /install\", \"--offline\", \"--prod\"/);
assert.match(containerSmoke, /build\", \"--pull=false\"/);
assert.match(containerSmoke, /up\", \"-d\", \"--pull\", \"never\", \"--no-build\"/);
assert.match(cleanCachePolicy, /--offline/);
assert.match(cleanCachePolicy, /unexpectedly succeeded/);
assert.match(acceptance, /scripts\/container-clean-cache\.mjs/);
assert.match(packageJson.scripts["test:bun"], /bun scripts\/collector-resilience\.mjs/);
assert.match(packageJson.scripts["test:bun"], /bun scripts\/migrate-bun-smoke\.mjs/);
assert.match(packageJson.scripts["test:bun"], /bun scripts\/backup-test\.mjs/);
assert.match(acceptance, /\["Bun migration fresh\/upgrade\/lock\/rollback\/retry smoke", "bun", \["scripts\/migrate-bun-smoke\.mjs"\]\]/, "authoritative acceptance must run migration smoke with Bun");
assert.match(acceptance, /\["offline encrypted backup and restore validation \(Bun\)", "bun", \["scripts\/backup-test\.mjs"\]\]/, "authoritative acceptance must run backup tests with Bun");
assert.match(acceptance, /\["deterministic collector failure and recovery suites \(Bun\)", "bun", \["scripts\/collector-resilience\.mjs"\]\]/, "authoritative acceptance must run collector resilience with Bun");
assert.match(workflow, /\$BUN_IMAGE\" scripts\/collector-resilience\.mjs/);
assert.match(workflow, /\$BUN_IMAGE\" scripts\/migrate-bun-smoke\.mjs/);
assert.match(workflow, /\$BUN_IMAGE\" scripts\/backup-test\.mjs/);
assert.match(workflow, /KUBECONFORM_SCHEMA_LOCATION:\s+\$\{\{ github\.workspace \}\}\/\.ci\/kubeconform-schemas\/v1\.31\.0-standalone-strict\//, "workflow must use the provisioned workspace schema directory");
for (const required of ["--no-cache", "--network", "none", "--pull=false", "container-context.mjs", "--load", "--pull=never", "--read-only", "pg_dump", "pg_restore", "nonroot", "Bun.which", "--version"]) {
  assert.match(cleanCacheBuild, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `clean-cache build must include ${required}`);
}
assert.match(cleanCacheBuild, /Bun\.which\('node'\)/, "clean-cache Bun images must have no Node executable on PATH");
assert.match(containerSmoke, /Bun\.which\('node'\)/, "container smoke must have no Node executable on PATH");

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
assert.ok(acceptanceDocs.includes(`docker image inspect '${bunImage}'`), "acceptance docs must state the exact Bun image prerequisite");
assert.match(compose, /migrate:[\s\S]*?user: nonroot/, "docker-compose migration must run as Bun");
for (const path of ["deploy/docker/web.Dockerfile", "deploy/docker/collector.Dockerfile", "deploy/docker/migrate.Dockerfile", "deploy/docker/backup.Dockerfile"]) {
  const dockerfile = await readFile(path, "utf8");
  const bunBases = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map(([, image]) => image).filter((image) => image === bunImage);
  assert.deepEqual(bunBases, [bunImage], `${path} must use exactly one shared pinned Bun base`);
  assert.doesNotMatch(dockerfile, /^FROM\s+node:|(?:CMD|ENTRYPOINT)\s+\["node"/im, `${path} must not retain a Node production runtime`);
}
console.log("offline acceptance preflight policy passed: pinned images, network-disabled frozen application builds, and pull-never smoke runs");
