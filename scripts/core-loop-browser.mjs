import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { createCollectorRuntime } from "../dist/apps/collector/src/main.js";
import { DeterministicKubernetesAdapter } from "../dist/packages/cluster/src/index.js";
import { PostgresDatabase, waitForDatabase } from "../dist/packages/db/src/index.js";

const webPort = Number(process.env.CORE_LOOP_WEB_PORT ?? "43192");
const databasePort = Number(process.env.CORE_LOOP_DATABASE_PORT ?? "45435");
const databaseName = `tracegarden-core-loop-pg-${process.pid}`;
const databaseUrl = `postgresql://tracegarden:local-only@127.0.0.1:${databasePort}/tracegarden`;
const postgresImage = "postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7";
const workspaceId = "workspace-single";
const baseUrl = `http://127.0.0.1:${webPort}`;
const scopeInput = {
  name: "Core loop Cluster",
  endpoint: "https://cluster.example.test",
  namespaces: ["tracegarden"],
  resourceKinds: ["Pod"],
};
const firstPod = {
  kind: "Pod",
  metadata: {
    name: "core-loop-pod",
    namespace: "tracegarden",
    uid: "core-loop-pod-uid",
    resourceVersion: "100",
    labels: { app: "core-loop" },
  },
  status: { phase: "Pending", conditions: [{ type: "Ready", status: "False", reason: "ContainersNotReady" }] },
};
const missedPod = {
  kind: "Pod",
  metadata: {
    name: "core-loop-recovered-pod",
    namespace: "tracegarden",
    uid: "core-loop-recovered-pod-uid",
    resourceVersion: "101",
    labels: { app: "core-loop" },
  },
  status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
};

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function imageAvailable(image) {
  try {
    docker("image", "inspect", image);
    return true;
  } catch {
    return false;
  }
}

function removeDatabase() {
  try {
    docker("rm", "-f", databaseName);
  } catch {
    // The disposable container is already absent.
  }
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    waitForExit(child),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await waitForExit(child);
}

async function waitForWeb(output) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health/readiness`);
      if (response.ok) return;
    } catch {
      // The web process is still starting.
    }
    if (attempt === 59) throw new Error(`Core-loop web did not become ready: ${output()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function createExperiment(page, hypothesis, change, observation) {
  const form = page.locator('form[action="/experiments?lang=zh-CN"]');
  await form.locator('textarea[name="hypothesis"]').fill(hypothesis);
  await form.locator('textarea[name="change"]').fill(change);
  await form.locator('textarea[name="observation"]').fill(observation);
  await form.locator('textarea[name="conclusion"]').fill("");
  await form.locator('select[name="state"]').selectOption("active");
  await form.locator('textarea[name="tags"]').fill("core-loop");
  await form.locator('textarea[name="workloads"]').fill("core-loop-cluster | tracegarden | Pod | core-loop-pod");
  await form.locator('input[name="gitRevision"]').fill("core-loop-revision");
  await form.getByRole("button", { name: "创建 Experiment" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Experiment 已创建/);
  const experiment = page.locator("article[data-experiment-id]").filter({ hasText: hypothesis }).first();
  const id = await experiment.getAttribute("data-experiment-id");
  assert.ok(id);
  return id;
}

async function experimentDetails(page, id) {
  return page.evaluate(async (experimentId) => {
    const response = await fetch(`/api/experiments/${encodeURIComponent(experimentId)}`);
    if (!response.ok) throw new Error(`experiment lookup failed: ${response.status}`);
    return (await response.json()).experiment;
  }, id);
}

async function suggestionFor(page, observationEntryId, experimentEntryId) {
  return page.evaluate(async ({ observationId, experimentId }) => {
    const response = await fetch("/api/correlations/suggestions");
    if (!response.ok) throw new Error(`suggestion lookup failed: ${response.status}`);
    const suggestions = (await response.json()).suggestions;
    return suggestions.find(({ leftEntryId, rightEntryId }) =>
      [leftEntryId, rightEntryId].includes(observationId) && [leftEntryId, rightEntryId].includes(experimentId));
  }, { observationId: observationEntryId, experimentId: experimentEntryId });
}

async function suggestionStatus(page, id) {
  return page.evaluate(async (suggestionId) => {
    const response = await fetch(`/api/correlations/suggestions/${encodeURIComponent(suggestionId)}`);
    if (!response.ok) throw new Error(`suggestion status lookup failed: ${response.status}`);
    return (await response.json()).suggestion;
  }, id);
}

if (!imageAvailable(postgresImage)) {
  throw new Error(`core-loop acceptance requires the pinned PostgreSQL image ${postgresImage}; refusing to pull it`);
}

let database;
let collector;
let web;
let browser;
let page;
let webOutput = "";
removeDatabase();
try {
  docker("run", "--pull=never", "-d", "--rm", "--name", databaseName, "-p", `${databasePort}:5432`, "-e", "POSTGRES_DB=tracegarden", "-e", "POSTGRES_USER=tracegarden", "-e", "POSTGRES_PASSWORD=local-only", postgresImage);
  await waitForDatabase({
    ping: async () => {
      try {
        docker("exec", databaseName, "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
  }, 60_000, 250);
  database = new PostgresDatabase(databaseUrl);
  await database.migrate();
  await database.clusterScope.save({ workspaceId, clusterId: "core-loop-cluster", ...scopeInput });

  web = spawn("bun", ["dist/apps/web/src/bun.js"], {
    env: { ...process.env, NODE_ENV: "test", DATABASE_MODE: undefined, DATABASE_URL: databaseUrl, PORT: String(webPort), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  web.stdout.on("data", (chunk) => { if (webOutput.length < 64_000) webOutput += String(chunk); });
  web.stderr.on("data", (chunk) => { if (webOutput.length < 64_000) webOutput += String(chunk); });
  await waitForWeb(() => webOutput);

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  assert.equal(await page.title(), "Tracegarden · 应用状态");
  assert.match(await page.locator("body").innerText(), /登录 Tracegarden/);
  await page.locator("#identity").selectOption("owner");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("h1").innerText(), /共享 Workspace/);
  assert.match(await page.locator("body").innerText(), /owner@example.test/);

  await page.locator("#cluster-name").fill(scopeInput.name);
  await page.locator("#cluster-endpoint").fill(scopeInput.endpoint);
  await page.locator("#cluster-namespaces").fill("tracegarden");
  await page.locator('input[name="resourceKinds"][value="Pod"]').check();
  await page.getByRole("button", { name: "保存 Cluster 范围" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Cluster 观测范围已保存/);
  const persistedScope = await database.clusterScope.get(workspaceId);
  assert.ok(persistedScope);
  assert.equal(persistedScope.clusterId, "core-loop-cluster");

  const adapter = new DeterministicKubernetesAdapter([], { listResults: [{ resources: [firstPod] }] });
  collector = await createCollectorRuntime({
    port: 0,
    host: "127.0.0.1",
    database,
    adapter,
    now: () => new Date("2099-01-01T00:00:00.000Z"),
    retentionCleanupIntervalMs: 86_400_000,
  });
  assert.equal(adapter.contacted, false);
  await page.waitForFunction(() => window.__tracegardenTimelineReadyCount > 0);

  const liveDeliveryStartedAt = performance.now();
  const firstResult = await collector.collectObservations();
  assert.equal(firstResult.length, 1);
  assert.equal(firstResult[0].duplicate, false);
  assert.equal(firstResult[0].entry.entryType, "observation");
  assert.equal(firstResult[0].entry.observation.name, firstPod.metadata.name);
  const observationEntryId = firstResult[0].entry.id;
  await page.locator(`[data-entry-id="${observationEntryId}"]`).waitFor({ state: "attached", timeout: 5_000 });
  const liveDeliveryElapsedMs = performance.now() - liveDeliveryStartedAt;
  assert.ok(liveDeliveryElapsedMs <= 5_000, `Ticket 11 live delivery exceeded five seconds: ${liveDeliveryElapsedMs.toFixed(1)}ms`);
  console.log(`Ticket 11 live delivery elapsed ${liveDeliveryElapsedMs.toFixed(1)}ms (threshold 5000ms)`);
  assert.match(await page.locator(`[data-entry-id="${observationEntryId}"]`).innerText(), /core-loop-pod/);
  const persistedObservation = await database.timeline.getTimelineEntry(workspaceId, observationEntryId);
  assert.ok(persistedObservation?.entryType === "observation" && persistedObservation.attentionItem);

  adapter.enqueueList([firstPod]);
  const duplicateResult = await collector.collectObservations();
  assert.equal(duplicateResult[0].duplicate, true);
  assert.equal(await page.locator(`[data-entry-id="${observationEntryId}"]`).count(), 1);

  await page.evaluate(() => window.__tracegardenTimelineEventSource.close());
  const readyCountBeforeRecovery = await page.evaluate(() => window.__tracegardenTimelineReadyCount);
  adapter.enqueueList([missedPod]);
  const missedResult = await collector.collectObservations();
  assert.equal(missedResult[0].duplicate, false);
  await page.evaluate(() => window.__tracegardenTimelineReconnect());
  await page.waitForFunction((count) => window.__tracegardenTimelineReadyCount > count, readyCountBeforeRecovery);
  await page.locator(`[data-entry-id="${missedResult[0].entry.id}"]`).waitFor({ state: "attached" });

  const confirmedExperimentId = await createExperiment(page, "Core-loop confirmed experiment", "Inspect the Pod", "Keep the observation distinct from the conclusion");
  const confirmedExperiment = await experimentDetails(page, confirmedExperimentId);
  assert.equal(confirmedExperiment.hypothesis, "Core-loop confirmed experiment");
  assert.equal(confirmedExperiment.workloads[0].name, "core-loop-pod");
  const confirmedSuggestion = await suggestionFor(page, observationEntryId, confirmedExperiment.timelineEntryId);
  assert.ok(confirmedSuggestion);
  assert.equal(confirmedSuggestion.status, "pending");
  assert.match(await page.locator(`[data-correlation-suggestion-id="${confirmedSuggestion.id}"]`).innerText(), /Core-loop confirmed experiment/);
  assert.doesNotMatch(await page.locator("body").innerText(), /(?:cause|root cause|根因|因果)/i);

  const rejectedExperimentId = await createExperiment(page, "Core-loop rejected experiment", "Reject the candidate", "Keep rejection separate");
  const rejectedExperiment = await experimentDetails(page, rejectedExperimentId);
  const rejectedSuggestion = await suggestionFor(page, observationEntryId, rejectedExperiment.timelineEntryId);
  assert.ok(rejectedSuggestion);
  assert.equal(rejectedSuggestion.status, "pending");
  const rejectedCard = page.locator(`[data-correlation-suggestion-id="${rejectedSuggestion.id}"]`);
  await rejectedCard.getByRole("button", { name: "拒绝 Correlation Suggestion" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Correlation Suggestion 已拒绝/);
  assert.equal(await page.locator(`[data-correlation-suggestion-id="${rejectedSuggestion.id}"]`).count(), 0);
  assert.equal((await suggestionStatus(page, rejectedSuggestion.id)).status, "rejected");

  const confirmedCard = page.locator(`[data-correlation-suggestion-id="${confirmedSuggestion.id}"]`);
  await confirmedCard.getByRole("button", { name: "确认 Correlation Suggestion" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /已确认，已创建 Confirmed Link/);
  const confirmedStatus = await suggestionStatus(page, confirmedSuggestion.id);
  assert.equal(confirmedStatus.status, "confirmed");
  assert.ok(confirmedStatus.confirmedLink);
  assert.equal((await suggestionStatus(page, rejectedSuggestion.id)).status, "rejected");
  assert.match(await page.locator(`[data-entry-id="${confirmedExperiment.timelineEntryId}"]`).innerText(), /Confirmed Link/);
  assert.doesNotMatch(await page.locator("body").innerText(), /(?:cause|root cause|根因|因果)/i);

  await page.goto(`${baseUrl}/app?lang=en`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.match(await page.locator("h1").innerText(), /Shared Workspace/);
  assert.match(await page.locator(`[data-entry-id="${observationEntryId}"]`).innerText(), /core-loop-pod/);
  assert.match(await page.locator(`[data-entry-id="${confirmedExperiment.timelineEntryId}"]`).innerText(), /Confirmed Link/);
  assert.match(await page.locator(`article[data-experiment-id="${confirmedExperimentId}"]`).innerText(), /Core-loop confirmed experiment/);
  assert.equal(await page.locator(`[data-correlation-suggestion-id="${rejectedSuggestion.id}"]`).count(), 0);
  assert.doesNotMatch(await page.locator("body").innerText(), /(?:cause|root cause)/i);
  console.log("Playwright core-loop acceptance passed: admitted login, deterministic Observation, live delivery/recovery, structured Experiments, rejected/confirmed correlation review, persisted history, and bilingual UI");
} finally {
  await collector?.close();
  await browser?.close();
  await stopProcess(web);
  await database?.close();
  removeDatabase();
}
