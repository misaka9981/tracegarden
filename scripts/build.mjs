import { cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const compiler = spawnSync("tsc", ["-p", "tsconfig.json"], { stdio: "inherit" });
if (compiler.status !== 0) process.exit(compiler.status ?? 1);

await rm("dist/packages/db/migrations", { recursive: true, force: true });
await mkdir("dist/packages/db/migrations", { recursive: true });
await cp("packages/db/migrations", "dist/packages/db/migrations", { recursive: true });
