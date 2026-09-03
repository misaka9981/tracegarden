import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
let running;

function run(label, command, args, extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n[acceptance] ${label}`);
    const child = spawn(command, args, {
      env: { ...process.env, ...extraEnvironment },
      stdio: "inherit",
    });
    running = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (running === child) running = undefined;
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} failed${signal ? ` (${signal})` : ` with exit code ${code ?? "unknown"}`}`));
    });
  });
}

const commands = [
  ["format check", pnpm, ["format:check"]],
  ["lint", pnpm, ["lint"]],
  ["strict typecheck", pnpm, ["typecheck"]],
  ["production build", pnpm, ["build"]],
  ["Bun compiled-ESM compatibility gate", "bun", ["scripts/bun-compatibility.mjs"]],
  ["Bun migration fresh/upgrade/lock/rollback/retry smoke", pnpm, ["test:migrate:bun"]],
  ["offline acceptance image preflight policy", process.execPath, ["scripts/acceptance-preflight.mjs"]],
  ["clean-cache frozen dependency fail-closed policy", process.execPath, ["scripts/container-context-clean-cache.mjs"]],
  ["clean Docker-cache offline container build", process.execPath, ["scripts/container-clean-cache.mjs"]],
  ["unit, authorization, telemetry, and domain failure suites", process.execPath, ["scripts/test.mjs"]],
  ["deterministic collector failure and recovery suites (Bun)", "bun", ["scripts/collector-resilience.mjs"]],
  ["real PostgreSQL integration, auth, retention, log-bound, and live timeline suites", process.execPath, ["scripts/postgres-smoke.mjs"]],
  ["existing bilingual browser smoke suite", process.execPath, ["scripts/browser-smoke.mjs"]],
  ["focused browser core-loop scenario", process.execPath, ["scripts/core-loop-browser.mjs"]],
  ["offline encrypted backup and restore validation", process.execPath, ["scripts/backup-test.mjs"]],
  ["provision checked-in Kubernetes schemas", process.execPath, ["scripts/provision-kubeconform-schemas.mjs"]],
  ["offline production deployment and backup manifest validation", process.execPath, ["scripts/chart-test.mjs"]],
  ["offline preview and promotion declaration validation", process.execPath, ["scripts/delivery-test.mjs"], { DELIVERY_RENDER: "true" }],
  ["delivery policy validation", process.execPath, ["scripts/delivery-policy.mjs"]],
  ["production web and collector non-root image smoke", process.execPath, ["scripts/container-smoke.mjs"]],
];

try {
  for (const [label, command, args, environment] of commands) await run(label, command, args, environment);
  console.log("\nTracegarden local acceptance workflow passed; no external integrations were contacted.");
} finally {
  if (running && running.exitCode === null) running.kill("SIGTERM");
}
