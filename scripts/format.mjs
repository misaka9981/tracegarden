import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const write = process.argv.includes("--write");
const roots = ["apps", "packages", "scripts", "types"];
const extensions = new Set([".ts", ".tsx", ".mjs", ".json", ".yaml", ".yml", ".css", ".sql"]);

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(path));
    else if ([...extensions].some((extension) => path.endsWith(extension))) files.push(path);
  }
  return files;
}

const files = (await Promise.all(roots.map((root) => filesIn(root)))).flat().sort();
const errors = [];
for (const path of files) {
  const original = await readFile(path, "utf8");
  const normalized = `${original.replace(/[ \t]+$/gm, "").replace(/\r\n/g, "\n").replace(/\n*$/, "")}\n`;
  if (write && original !== normalized) await writeFile(path, normalized);
  if (!write && original !== normalized) errors.push(path);
}
if (errors.length) {
  console.error(`Formatting differs in: ${errors.join(", ")}`);
  process.exitCode = 1;
}
