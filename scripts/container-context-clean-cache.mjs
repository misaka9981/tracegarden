import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = await mkdtemp(join(tmpdir(), "tracegarden-clean-cache-"));
const context = join(root, "context");
const store = join(root, "store");
await mkdir(context);
await mkdir(store);
try {
  for (const path of ["package.json", "pnpm-lock.yaml", ".npmrc"]) {
    await cp(path, join(context, path));
  }
  const install = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [
    "--dir", context, "install", "--offline", "--prod", "--frozen-lockfile", "--ignore-workspace", "--ignore-scripts", "--store-dir", store,
  ], {
    env: { ...process.env, npm_config_offline: "true" },
    stdio: "ignore",
  });
  if (install.status === 0) throw new Error("clean-cache dependency install unexpectedly succeeded");
  console.log("clean-cache container context policy passed: offline production install fails closed without the preloaded pnpm store");
} finally {
  await rm(root, { recursive: true, force: true });
}
