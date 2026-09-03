import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const context = resolve(process.env.TRACEGARDEN_CONTAINER_CONTEXT?.trim() || ".scratch/container-context");
const required = [
  "dist/apps/web/src/bun.js",
  "dist/apps/collector/src/main.js",
  "dist/apps/migrate/src/main.js",
  "dist/packages/db/src/index.js",
  "node_modules/pg",
  "node_modules/better-auth",
  "pnpm-lock.yaml",
  "package.json",
];
for (const path of required) {
  try {
    await access(path);
  } catch (error) {
    throw new Error(`container context requires the frozen ${path}; run the repository build/install first`, { cause: error });
  }
}
await rm(context, { recursive: true, force: true });
await mkdir(context, { recursive: true });
await cp("dist", `${context}/dist`, { recursive: true, verbatimSymlinks: true });
for (const path of ["package.json", "pnpm-lock.yaml", ".npmrc"]) {
  await cp(path, `${context}/${path}`, { verbatimSymlinks: true });
}
const install = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [
  "--dir", context, "install", "--offline", "--prod", "--frozen-lockfile", "--ignore-workspace", "--ignore-scripts",
], {
  env: { ...process.env, npm_config_offline: "true" },
  stdio: "inherit",
});
if (install.error) throw install.error;
if (install.status !== 0) throw new Error(`offline production dependency install failed with exit code ${install.status ?? "unknown"}`);
const lock = await readFile("pnpm-lock.yaml");
await writeFile(`${context}/manifest.json`, JSON.stringify({
  packageManager: "pnpm@11.9.0",
  lockSha256: createHash("sha256").update(lock).digest("hex"),
  source: "frozen repository install",
}, null, 2) + "\n");
console.log(`offline container context ready: ${context}`);
