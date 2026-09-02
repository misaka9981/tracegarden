import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const postgresImage = "postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7";
const nodeImage = "node:26.8-bookworm@sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89";
const smokeScripts = ["scripts/browser-smoke.mjs", "scripts/postgres-smoke.mjs", "scripts/core-loop-browser.mjs"];
const acceptanceDocs = await readFile("docs/acceptance.md", "utf8");

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
console.log("offline acceptance preflight policy passed: browser, PostgreSQL, and core-loop smokes inspect the exact local image before docker run");
