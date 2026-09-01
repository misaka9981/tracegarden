import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const port = 43191;
const child = spawn(process.execPath, ["dist/apps/web/src/main.js"], {
  env: { ...process.env, NODE_ENV: "test", DATABASE_MODE: "memory", PORT: String(port), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
let browser;

try {
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

  await page.goto(`http://127.0.0.1:${port}/app?lang=en`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.title(), "Tracegarden · Shared Workspace");
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.match(await page.locator("h1").innerText(), /Shared Workspace/);
  assert.match(await page.locator("body").innerText(), /workspace:read/);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForLoadState("domcontentloaded");
  await page.locator("#identity").selectOption("rejected");
  await page.getByRole("button", { name: "Sign in" }).click();
  assert.equal(await page.title(), "Tracegarden · Workspace access denied");
  assert.match(await page.locator("body").innerText(), /no valid Workspace admission/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.match(await page.locator("body").innerText(), /Sign in to Tracegarden/);
  console.log("Playwright browser smoke passed");
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  if (child.exitCode !== null && child.exitCode !== 0) console.error(output);
}
