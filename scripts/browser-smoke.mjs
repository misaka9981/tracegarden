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
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.title(), "Tracegarden · 应用状态");
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  assert.match(await page.locator("h1").innerText(), /应用状态/);
  assert.match(await page.locator("body").innerText(), /简体中文/);
  assert.doesNotMatch(await page.content(), /DATABASE_URL|postgres(ql)?:\/\//i);

  await page.goto(`http://127.0.0.1:${port}/?lang=en`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.title(), "Tracegarden · Application status");
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.match(await page.locator("h1").innerText(), /Application status/);
  assert.match(await page.locator("body").innerText(), /PostgreSQL database/);
  console.log("Playwright browser smoke passed");
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  if (child.exitCode !== null && child.exitCode !== 0) console.error(output);
}
