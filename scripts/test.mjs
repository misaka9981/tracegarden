import assert from "node:assert/strict";
import { collectorStatus, createCollectorRuntime } from "../dist/apps/collector/src/main.js";
import { createWebRuntime, renderStatusPage } from "../dist/apps/web/src/server.js";
import { createDatabase, MemoryDatabase } from "../dist/packages/db/src/index.js";
import { catalogs, parseLanguage } from "../dist/packages/i18n/src/index.js";

assert.equal(parseLanguage(undefined), "zh-CN");
assert.equal(parseLanguage("en"), "en");
assert.equal(catalogs["zh-CN"].statusTitle, "应用状态");
assert.equal(catalogs.en.statusTitle, "Application status");
assert.match(renderStatusPage("zh-CN", true), /应用状态/);
assert.match(renderStatusPage("en", true), /Application status/);
assert.ok(!renderStatusPage("en", true).includes("DATABASE_URL"));

const database = new MemoryDatabase();
assert.equal(await database.ping(), false);
await database.migrate();
assert.equal(await database.ping(), true);

const collector = collectorStatus();
assert.equal(collector.status, "ready");
assert.equal(collector.checks.clusterContacted, false);
const collectorRuntime = await createCollectorRuntime({ port: 43202, host: "127.0.0.1" });
try {
  const collectorResponse = await fetch("http://127.0.0.1:43202/health/readiness");
  assert.equal(collectorResponse.status, 200);
  const collectorReadiness = await collectorResponse.json();
  assert.equal(collectorReadiness.status, "ready");
  assert.equal(collectorReadiness.checks.clusterContacted, false);
} finally {
  await collectorRuntime.close();
}

let migrationFailed = false;
try {
  await createWebRuntime({
    database: { kind: "postgres", migrate: async () => { throw new Error("migration failed"); }, ping: async () => true, close: async () => {} },
    port: 0,
  });
} catch {
  migrationFailed = true;
}
assert.equal(migrationFailed, true);
let productionMemoryRejected = false;
try {
  createDatabase({ NODE_ENV: "production", DATABASE_MODE: "memory" });
} catch {
  productionMemoryRejected = true;
}
assert.equal(productionMemoryRejected, true);
assert.throws(() => createDatabase({ DATABASE_MODE: "memory" }));
await assert.rejects(
  createWebRuntime({ database: new MemoryDatabase(), environment: { NODE_ENV: "production" }, port: 0 }),
  /Memory database is not allowed in production/,
);
console.log("unit and collector readiness checks passed");
