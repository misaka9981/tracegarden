import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
for (const packagePath of ["packages/db/dist", "packages/contracts/dist", "packages/i18n/dist"]) {
  await rm(packagePath, { recursive: true, force: true });
}
