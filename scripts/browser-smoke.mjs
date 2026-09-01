import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import { PostgresDatabase } from "../dist/packages/db/src/index.js";
import { normalizePodObservation } from "../dist/packages/cluster/src/index.js";

const port = 43191;
const databasePort = 45434;
const databaseName = `tracegarden-browser-pg-${process.pid}`;
const databaseUrl = `postgresql://tracegarden:local-only@127.0.0.1:${databasePort}/tracegarden`;
const postgresImage = "postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7";
let child;
let output = "";
let browser;
let timelineDatabase;

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function removeDatabase() {
  try { docker("rm", "-f", databaseName); } catch { /* already absent */ }
}

removeDatabase();
try {
  docker("run", "-d", "--name", databaseName, "-p", `${databasePort}:5432`, "-e", "POSTGRES_DB=tracegarden", "-e", "POSTGRES_USER=tracegarden", "-e", "POSTGRES_PASSWORD=local-only", postgresImage);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      docker("exec", databaseName, "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT 1");
      break;
    } catch {
      if (attempt === 39) throw new Error("PostgreSQL did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  timelineDatabase = new PostgresDatabase(databaseUrl);
  await timelineDatabase.migrate();
  child = spawn(process.execPath, ["dist/apps/web/src/main.js"], {
    env: { ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // The web process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, `web process did not become ready: ${output}`);
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.title(), "Tracegarden · 应用状态");
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  assert.match(await page.locator("h1").innerText(), /应用状态/);
  assert.match(await page.locator("body").innerText(), /简体中文/);
  assert.match(await page.locator("body").innerText(), /登录 Tracegarden/);
  assert.doesNotMatch(await page.content(), /DATABASE_URL|postgres(ql)?:\/\//i);

  await page.locator("#identity").selectOption("owner");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  assert.match(await page.locator("h1").innerText(), /共享 Workspace/);
  assert.match(await page.locator("body").innerText(), /owner@example.test/);
  assert.match(await page.locator("body").innerText(), /Recent Log Window/);
  assert.match(await page.locator("body").innerText(), /logs:read/);
  assert.match(await page.locator("body").innerText(), /Observation 保留策略/);
  assert.equal(await page.locator("#retention-days").inputValue(), "90");
  await page.locator("#retention-days").fill("30");
  await page.getByRole("button", { name: "保存保留策略" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Observation 保留策略已保存/);
  assert.equal(await page.locator("#retention-days").inputValue(), "30");

  await page.goto(`http://127.0.0.1:${port}/app?lang=en`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.title(), "Tracegarden · Shared Workspace");
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.match(await page.locator("h1").innerText(), /Shared Workspace/);
  assert.match(await page.locator("body").innerText(), /workspace:read/);
  assert.match(await page.locator("body").innerText(), /Observation retention/);

  await page.goto(`http://127.0.0.1:${port}/app?lang=zh-CN`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("假设").fill("**浏览器假设**");
  await page.getByLabel("变更").fill("调整 Deployment");
  await page.getByLabel("观察").fill("Pod 已恢复");
  await page.getByLabel("结论").fill("");
  await page.getByLabel("生命周期状态").selectOption("active");
  await page.getByLabel("标签（每行一个）").fill("浏览器一\r\n浏览器二");
  await page.getByRole("button", { name: "创建 Experiment" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Experiment 已创建/);
  assert.match(await page.locator("body").innerText(), /浏览器假设/);
  assert.match(await page.locator("body").innerText(), /浏览器一, 浏览器二/);
  const experimentId = await page.locator("article[data-experiment-id]").first().getAttribute("data-experiment-id");
  assert.ok(experimentId);
  await page.goto(`http://127.0.0.1:${port}/experiments/${experimentId}?lang=en`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.match(await page.locator("body").innerText(), /Experiments/);
  assert.match(await page.locator("body").innerText(), /\*\*浏览器假设\*\*/);
  const updateForm = page.locator("details").first();
  await updateForm.locator("summary").click();
  await updateForm.locator('textarea[name="conclusion"]').fill("Verified in English");
  await updateForm.locator('select[name="state"]').selectOption("concluded");
  await updateForm.getByRole("button", { name: "Update Experiment" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Experiment updated/);
  await page.goto(`http://127.0.0.1:${port}/experiments/${experimentId}?lang=zh-CN`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  assert.match(await page.locator("body").innerText(), /Verified in English/);

  await page.goto(`http://127.0.0.1:${port}/members?lang=zh-CN`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  assert.match(await page.locator("h1").innerText(), /成员管理/);
  await page.locator("#invite-email").fill(" INVITED@EXAMPLE.TEST ");
  await page.getByRole("button", { name: "创建 Invitation" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Invitation 已创建/);
  await page.locator("#invite-email").fill("rejected@example.test");
  await page.getByRole("button", { name: "创建 Invitation" }).click();
  await page.waitForLoadState("domcontentloaded");
  const rejectedInvitationRow = page.locator("tr").filter({ hasText: "rejected@example.test" });
  await rejectedInvitationRow.getByRole("button", { name: "撤销 Invitation" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Invitation 已撤销/);
  await page.goto(`http://127.0.0.1:${port}/members?lang=en`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.match(await page.locator("h1").innerText(), /Membership management/);
  assert.match(await page.locator("body").innerText(), /invited@example.test/);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForLoadState("domcontentloaded");
  await page.locator("#identity").selectOption("invited");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Shared Workspace/);
  assert.match(await page.locator("body").innerText(), /do not have the Capability to read the Recent Log Window/);
  assert.equal(await page.locator('textarea[name="hypothesis"]').count(), 0);
  assert.equal(await page.getByRole("button", { name: "Create Experiment" }).count(), 0);
  assert.equal(await page.locator('a[href^="/members"]').count(), 0);
  assert.match(await page.locator("body").innerText(), /You do not have the Capability to manage Observation retention/);
  assert.equal(await page.getByRole("button", { name: "Save retention policy" }).count(), 0);
  const viewerRetentionAttempt = await page.evaluate(async () => (await fetch("/api/retention", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ retentionDays: 7 }) })).status);
  assert.equal(viewerRetentionAttempt, 403);
  const viewerCleanupAttempt = await page.evaluate(async () => (await fetch("/api/retention/cleanup", { method: "POST" })).status);
  assert.equal(viewerCleanupAttempt, 403);
  const viewerInvitationAttempt = await page.evaluate(async () => (await fetch("/api/invitations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "another@example.test" }) })).status);
  assert.equal(viewerInvitationAttempt, 403);
  const viewerRoleAttempt = await page.evaluate(async () => (await fetch("/api/members/not-authorized/role", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "owner" }) })).status);
  assert.equal(viewerRoleAttempt, 403);
  const viewerCookie = await page.context().cookies().then((cookies) => cookies.map(({ name, value }) => `${name}=${value}`).join("; "));
  const viewerMembersPage = await fetch(`http://127.0.0.1:${port}/members?lang=en`, { headers: { cookie: viewerCookie } });
  assert.equal(viewerMembersPage.status, 403);
  assert.match(await viewerMembersPage.text(), /do not have permission/);
  const viewerMembersPageChinese = await fetch(`http://127.0.0.1:${port}/members?lang=zh-CN`, { headers: { cookie: viewerCookie } });
  assert.equal(viewerMembersPageChinese.status, 403);
  assert.match(await viewerMembersPageChinese.text(), /你没有管理成员/);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForLoadState("domcontentloaded");
  await page.locator("#identity").selectOption("owner");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "Run cleanup" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Cleanup complete: eligible 0, protected 0, deleted 0 Observations/);
  await page.goto(`http://127.0.0.1:${port}/members?lang=en`, { waitUntil: "domcontentloaded" });
  const invitedRole = page.locator('select[aria-label="Role: invited@example.test"]');
  await invitedRole.selectOption("operator");
  await invitedRole.locator("xpath=ancestor::form").getByRole("button", { name: "Save role" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Role updated/);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForLoadState("domcontentloaded");
  await page.locator("#identity").selectOption("invited");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForLoadState("domcontentloaded");
  const operatorSession = await page.evaluate(async () => (await fetch("/api/session")).json());
  assert.equal(operatorSession.member.role, "operator");
  assert.ok(operatorSession.member.capabilities.includes("experiment:write"));
  assert.ok(!operatorSession.member.capabilities.includes("membership:manage"));
  assert.equal((await page.goto(`http://127.0.0.1:${port}/members?lang=en`))?.status(), 403);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForLoadState("domcontentloaded");
  await page.locator("#identity").selectOption("rejected");
  await page.getByRole("button", { name: "Sign in" }).click();
  assert.equal(await page.title(), "Tracegarden · Workspace access denied");
  assert.match(await page.locator("body").innerText(), /no valid Workspace admission/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Sign in to Tracegarden/);

  const timelineScope = {
    workspaceId: "workspace-single",
    clusterId: "browser-cluster",
    name: "Browser Cluster",
    endpoint: "https://cluster.example.test",
    namespaces: ["tracegarden"],
    resourceKinds: ["Pod"],
  };
  await timelineDatabase.clusterScope.save(timelineScope);
  await timelineDatabase.timeline.recordObservation(normalizePodObservation(timelineScope, {
    kind: "Pod",
    metadata: { name: "pending-review", namespace: "tracegarden", uid: "browser-pending", resourceVersion: "1" },
    status: { phase: "Pending", conditions: [{ type: "Ready", status: "False" }] },
  }, "2099-01-01T00:00:00.000Z"));
  await timelineDatabase.timeline.recordObservation(normalizePodObservation(timelineScope, {
    kind: "Pod",
    metadata: { name: "english-pending", namespace: "tracegarden", uid: "browser-english-pending", resourceVersion: "2" },
    status: { phase: "Pending", conditions: [{ type: "Ready", status: "False" }] },
  }, "2099-01-01T00:00:01.000Z"));
  await timelineDatabase.timeline.recordObservation(normalizePodObservation(timelineScope, {
    kind: "Pod",
    metadata: { name: "running", namespace: "tracegarden", uid: "browser-running", resourceVersion: "3" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }, "2099-01-01T00:00:02.000Z"));
  await page.goto(`http://127.0.0.1:${port}/?lang=zh-CN`, { waitUntil: "domcontentloaded" });
  await page.locator("#identity").selectOption("owner");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Timeline/);
  const liveObservation = normalizePodObservation(timelineScope, {
    kind: "Pod",
    metadata: { name: "browser-live-entry", namespace: "tracegarden", uid: "browser-live-entry", resourceVersion: "4" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }, "2099-01-01T00:00:03.000Z");
  const liveResult = await timelineDatabase.timeline.recordObservation(liveObservation);
  const liveEntry = page.locator(`[data-entry-id="${liveResult.entry.id}"]`);
  await liveEntry.waitFor({ state: "attached" });
  assert.match(await liveEntry.innerText(), /browser-live-entry/);
  const hintCountBeforeDuplicate = await page.evaluate(() => window.__tracegardenTimelineHintCount);
  docker("exec", databaseName, "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", `SELECT pg_notify('tracegarden_timeline', json_build_object('entryId', '${liveResult.entry.id}')::text);`);
  await page.waitForFunction((count) => window.__tracegardenTimelineHintCount > count, hintCountBeforeDuplicate);
  assert.equal(await page.locator(`[data-entry-id="${liveResult.entry.id}"]`).count(), 1);
  let recoveryFailureInjected = false;
  await page.route("**/api/timeline**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (!recoveryFailureInjected && requestUrl.pathname === "/api/timeline" && requestUrl.searchParams.has("sseClientId")) {
      recoveryFailureInjected = true;
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      return;
    }
    await route.continue();
  });
  const readyCountBeforeRecoveryFailure = await page.evaluate(() => window.__tracegardenTimelineReadyCount);
  const failedRecoveryObservation = normalizePodObservation(timelineScope, {
    kind: "Pod",
    metadata: { name: "browser-recovery-retry", namespace: "tracegarden", uid: "browser-recovery-retry", resourceVersion: "5" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }, "2099-01-01T00:00:03.500Z");
  const failedRecoveryResult = await timelineDatabase.timeline.recordObservation(failedRecoveryObservation);
  await page.locator(`[data-entry-id="${failedRecoveryResult.entry.id}"]`).waitFor({ state: "attached" });
  assert.equal(recoveryFailureInjected, true);
  await page.waitForFunction((count) => window.__tracegardenTimelineReadyCount > count, readyCountBeforeRecoveryFailure);
  await page.unroute("**/api/timeline**");
  const readyCountBeforeReconnect = await page.evaluate(() => window.__tracegardenTimelineReadyCount);
  await page.evaluate(() => window.__tracegardenTimelineEventSource.close());
  const missedObservation = normalizePodObservation(timelineScope, {
    kind: "Pod",
    metadata: { name: "browser-missed-entry", namespace: "tracegarden", uid: "browser-missed-entry", resourceVersion: "5" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }, "2099-01-01T00:00:04.000Z");
  const missedResult = await timelineDatabase.timeline.recordObservation(missedObservation);
  await page.evaluate(() => window.__tracegardenTimelineReconnect());
  await page.waitForFunction((count) => window.__tracegardenTimelineReadyCount > count, readyCountBeforeReconnect);
  await page.locator(`[data-entry-id="${missedResult.entry.id}"]`).waitFor({ state: "attached" });
  assert.equal(await page.locator(`[data-entry-id="${missedResult.entry.id}"]`).count(), 1);
  await timelineDatabase.timeline.recordObservation(liveObservation);
  assert.equal(await page.locator(`[data-entry-id="${liveResult.entry.id}"]`).count(), 1);
  await page.locator("#timeline-namespace").fill("tracegarden");
  await page.locator("#timeline-attention").selectOption("unread");
  await page.getByRole("button", { name: "筛选 Timeline" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /pending-review/);
  assert.match(await page.locator("body").innerText(), /待处理/);
  assert.match(await page.locator("body").innerText(), /未读 Attention Item: 2/);
  await page.locator('[data-entry-id]').filter({ hasText: "pending-review" }).getByRole("button", { name: "标记为已查看" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /已标记为已查看/);
  assert.match(await page.locator("body").innerText(), /未读 Attention Item: 1/);
  await page.goto(`http://127.0.0.1:${port}/app?lang=en`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.match(await page.locator("body").innerText(), /Shared Workspace/);
  await page.locator("#timeline-namespace").fill("tracegarden");
  await page.locator("#timeline-attention").selectOption("unread");
  await page.getByRole("button", { name: "Filter Timeline" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /english-pending/);
  assert.match(await page.locator("body").innerText(), /Unread Attention Items: 1/);
  await page.locator('[data-entry-id]').filter({ hasText: "english-pending" }).getByRole("button", { name: "Mark reviewed" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Marked reviewed/);
  assert.match(await page.locator("body").innerText(), /Unread Attention Items: 0/);
  const correlationExperiment = await page.evaluate(async () => {
    const response = await fetch("/api/experiments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hypothesis: "浏览器关系", change: "检查 Pod", observation: "等待审核", conclusion: "", state: "active", tags: [], workloads: [{ clusterId: "browser-cluster", namespace: "tracegarden", kind: "Pod", name: "pending-review" }] }),
    });
    return { status: response.status, experiment: (await response.json()).experiment };
  });
  assert.equal(correlationExperiment.status, 201);
  assert.ok(correlationExperiment.experiment.timelineEntryId);
  await page.goto(`http://127.0.0.1:${port}/app?lang=zh-CN`, { waitUntil: "domcontentloaded" });
  assert.match(await page.locator("body").innerText(), /Correlation Suggestions/);
  assert.doesNotMatch(await page.locator("body").innerText(), /cause|root cause/i);
  const correlationSuggestionId = await page.evaluate(async (timelineEntryId) => {
    const suggestions = (await (await fetch("/api/correlations/suggestions")).json()).suggestions;
    return suggestions.find((suggestion) => suggestion.leftEntryId === timelineEntryId || suggestion.rightEntryId === timelineEntryId)?.id;
  }, correlationExperiment.experiment.timelineEntryId);
  assert.ok(correlationSuggestionId);
  const correlationCard = page.locator(`[data-correlation-suggestion-id="${correlationSuggestionId}"]`);
  assert.match(await correlationCard.innerText(), /浏览器关系|pending-review/);
  const createPendingRejectionExperiment = async (hypothesis) => page.evaluate(async (value) => {
    const response = await fetch("/api/experiments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hypothesis: value, change: "检查 Pod", observation: "保持待审核", conclusion: "", state: "active", tags: [], workloads: [{ clusterId: "browser-cluster", namespace: "tracegarden", kind: "Pod", name: "pending-review" }] }),
    });
    return { status: response.status, experiment: (await response.json()).experiment };
  }, hypothesis);
  const chineseRejectionExperiment = await createPendingRejectionExperiment("浏览器拒绝关系");
  const englishRejectionExperiment = await createPendingRejectionExperiment("Browser rejection relationship");
  assert.equal(chineseRejectionExperiment.status, 201);
  assert.equal(englishRejectionExperiment.status, 201);
  const chineseRejectionSuggestionId = await page.evaluate(async (timelineEntryId) => {
    const suggestions = (await (await fetch("/api/correlations/suggestions")).json()).suggestions;
    return suggestions.find((suggestion) => suggestion.leftEntryId === timelineEntryId || suggestion.rightEntryId === timelineEntryId)?.id;
  }, chineseRejectionExperiment.experiment.timelineEntryId);
  const englishRejectionSuggestionId = await page.evaluate(async (timelineEntryId) => {
    const suggestions = (await (await fetch("/api/correlations/suggestions")).json()).suggestions;
    return suggestions.find((suggestion) => suggestion.leftEntryId === timelineEntryId || suggestion.rightEntryId === timelineEntryId)?.id;
  }, englishRejectionExperiment.experiment.timelineEntryId);
  assert.ok(chineseRejectionSuggestionId);
  assert.ok(englishRejectionSuggestionId);
  await page.goto(`http://127.0.0.1:${port}/app?lang=zh-CN`, { waitUntil: "domcontentloaded" });
  const chineseRejectionCard = page.locator(`[data-correlation-suggestion-id="${chineseRejectionSuggestionId}"]`);
  await chineseRejectionCard.getByRole("button", { name: "拒绝 Correlation Suggestion" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Correlation Suggestion 已拒绝/);
  assert.equal(await page.locator(`[data-correlation-suggestion-id="${chineseRejectionSuggestionId}"]`).count(), 0);
  const chinesePersistedStatus = await page.evaluate(async (suggestionId) => (await (await fetch(`/api/correlations/suggestions/${suggestionId}`)).json()).suggestion.status, chineseRejectionSuggestionId);
  assert.equal(chinesePersistedStatus, "rejected");
  await page.goto(`http://127.0.0.1:${port}/app?lang=en`, { waitUntil: "domcontentloaded" });
  const englishRejectionCard = page.locator(`[data-correlation-suggestion-id="${englishRejectionSuggestionId}"]`);
  await englishRejectionCard.getByRole("button", { name: "Reject Correlation Suggestion" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Correlation Suggestion rejected/);
  assert.equal(await page.locator(`[data-correlation-suggestion-id="${englishRejectionSuggestionId}"]`).count(), 0);
  const englishPersistedStatus = await page.evaluate(async (suggestionId) => (await (await fetch(`/api/correlations/suggestions/${suggestionId}`)).json()).suggestion.status, englishRejectionSuggestionId);
  assert.equal(englishPersistedStatus, "rejected");

  await page.goto(`http://127.0.0.1:${port}/members?lang=en`, { waitUntil: "domcontentloaded" });
  const invitedViewerRole = page.locator('select[aria-label="Role: invited@example.test"]');
  await invitedViewerRole.selectOption("viewer");
  await invitedViewerRole.locator("xpath=ancestor::form").getByRole("button", { name: "Save role" }).click();
  await page.waitForLoadState("domcontentloaded");

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForLoadState("domcontentloaded");
  const unauthorizedCorrelationReview = await page.evaluate(async (suggestionId) => (await fetch(`/api/correlations/suggestions/${suggestionId}/confirm`, { method: "POST" })).status, correlationSuggestionId);
  assert.equal(unauthorizedCorrelationReview, 401);

  await page.locator("#identity").selectOption("invited");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForLoadState("domcontentloaded");
  await page.goto(`http://127.0.0.1:${port}/app?lang=zh-CN`, { waitUntil: "domcontentloaded" });
  assert.match(await page.locator("body").innerText(), /你没有审核 Correlation Suggestion 的 Capability/);
  const deniedCorrelationCard = page.locator(`[data-correlation-suggestion-id="${correlationSuggestionId}"]`);
  assert.equal(await deniedCorrelationCard.getByRole("button", { name: "确认 Correlation Suggestion" }).count(), 0);
  const deniedCorrelationReview = await page.evaluate(async (suggestionId) => (await fetch(`/api/correlations/suggestions/${suggestionId}/confirm`, { method: "POST" })).status, correlationSuggestionId);
  assert.equal(deniedCorrelationReview, 403);
  await page.goto(`http://127.0.0.1:${port}/app?lang=en`, { waitUntil: "domcontentloaded" });
  assert.match(await page.locator("body").innerText(), /You do not have the Capability to review Correlation Suggestions/);
  assert.equal(await page.locator(`[data-correlation-suggestion-id="${correlationSuggestionId}"]`).getByRole("button", { name: "Confirm Correlation Suggestion" }).count(), 0);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForLoadState("domcontentloaded");
  await page.locator("#identity").selectOption("owner");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForLoadState("domcontentloaded");
  await page.goto(`http://127.0.0.1:${port}/app?lang=zh-CN`, { waitUntil: "domcontentloaded" });
  const correlationOwnerCard = page.locator(`[data-correlation-suggestion-id="${correlationSuggestionId}"]`);
  await correlationOwnerCard.getByRole("button", { name: "确认 Correlation Suggestion" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /已确认，已创建 Confirmed Link/);
  const conflictingReview = await page.evaluate(async (suggestionId) => {
    const response = await fetch(`/correlations/suggestions/${suggestionId}/reject?lang=en`, { method: "POST" });
    return { status: response.status, body: await response.text() };
  }, correlationSuggestionId);
  assert.equal(conflictingReview.status, 409);
  assert.match(conflictingReview.body, /decision conflict/);
  assert.doesNotMatch(conflictingReview.body, /Correlation Suggestion rejected/i);
  await page.goto(`http://127.0.0.1:${port}/app?lang=en`, { waitUntil: "domcontentloaded" });
  assert.match(await page.locator("body").innerText(), /Confirmed Link/);
  assert.match(await page.locator(`[data-entry-id="${correlationExperiment.experiment.timelineEntryId}"]`).innerText(), /Confirmed Link/);
  console.log("Playwright browser smoke passed");
} finally {
  await timelineDatabase?.close();
  await browser?.close();
  child?.kill("SIGTERM");
  if (child?.exitCode !== null && child?.exitCode !== 0) console.error(output);
  removeDatabase();
}
