import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import { PostgresDatabase } from "../dist/packages/db/src/index.js";
import { normalizePodObservation } from "../dist/packages/cluster/src/index.js";

const port = 43191;
const databasePort = 45434;
const databaseName = `tracegarden-browser-pg-${process.pid}`;
const databaseUrl = `postgresql://tracegarden:local-only@127.0.0.1:${databasePort}/tracegarden`;
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
  docker("run", "-d", "--name", databaseName, "-p", `${databasePort}:5432`, "-e", "POSTGRES_DB=tracegarden", "-e", "POSTGRES_USER=tracegarden", "-e", "POSTGRES_PASSWORD=local-only", "postgres:18.3-alpine");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      docker("exec", databaseName, "psql", "-U", "tracegarden", "-d", "tracegarden", "-c", "SELECT 1");
      break;
    } catch {
      if (attempt === 39) throw new Error("PostgreSQL did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
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

  await page.goto(`http://127.0.0.1:${port}/app?lang=en`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.title(), "Tracegarden · Shared Workspace");
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.match(await page.locator("h1").innerText(), /Shared Workspace/);
  assert.match(await page.locator("body").innerText(), /workspace:read/);

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
  assert.equal(await page.locator('a[href^="/members"]').count(), 0);
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

  timelineDatabase = new PostgresDatabase(databaseUrl);
  await timelineDatabase.migrate();
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
  console.log("Playwright browser smoke passed");
} finally {
  await timelineDatabase?.close();
  await browser?.close();
  child?.kill("SIGTERM");
  if (child?.exitCode !== null && child?.exitCode !== 0) console.error(output);
  removeDatabase();
}
