import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["apps", "packages", "scripts", "types"];
const sourceFiles = [];
const errors = [];
const secretPattern = /(-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY-----|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})/;
const policyRules = [
  ["CommonJS require", /\brequire\s*\(/],
  ["dynamic code execution", /\beval\s*\(|\bnew\s+Function\s*\(/],
  ["explicit any", /(?:[:]|\bas)\s*any\b/],
];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (path.endsWith(".ts") || path.endsWith(".mjs")) sourceFiles.push(path);
  }
}

await Promise.all(roots.map(visit));
for (const path of sourceFiles.sort()) {
  const source = await readFile(path, "utf8");
  if (secretPattern.test(source)) errors.push(`${path}: possible credential`);
  for (const [name, rule] of policyRules) {
    if (rule.test(source)) errors.push(`${path}: ${name} is not allowed`);
  }
  if (path.endsWith(".mjs")) {
    const syntax = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
    if (syntax.status !== 0) errors.push(`${path}: ${syntax.stderr.trim() || "JavaScript syntax check failed"}`);
  }
}

const types = spawnSync("tsc", ["--noEmit", "--pretty", "false", "-p", "tsconfig.json"], { encoding: "utf8" });
if (types.status !== 0) errors.push(`TypeScript lint check failed:\n${types.stdout}${types.stderr}`);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
}
