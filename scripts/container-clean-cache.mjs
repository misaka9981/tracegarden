import { execFileSync } from "node:child_process";

const context = process.env.TRACEGARDEN_CONTAINER_CONTEXT?.trim() || ".scratch/container-context";
const nodeImage = "node:26.8-bookworm@sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89";
const postgresImage = "postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7";
const builds = [
  ["web", "deploy/docker/web.Dockerfile", true],
  ["collector", "deploy/docker/collector.Dockerfile", true],
  ["migrate", "deploy/docker/migrate.Dockerfile", true],
  ["backup", "deploy/docker/backup.Dockerfile", false],
];

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: "inherit" });
}
function requireImage(image) {
  try {
    docker(["image", "inspect", image]);
  } catch (error) {
    throw new Error(`clean-cache build requires the preloaded pinned image ${image}`, { cause: error });
  }
}

requireImage(nodeImage);
requireImage(postgresImage);
execFileSync(process.execPath, ["scripts/container-context.mjs"], { stdio: "inherit" });
for (const [service, dockerfile, frozen] of builds) {
  const tag = `tracegarden-clean-cache-${process.pid}-${service}:test`;
  const args = [
    "buildx", "build", "--load", "--no-cache", "--network", "none", "--pull=false",
    "--platform", "linux/arm64", "--file", dockerfile, "--tag", tag,
    ...(frozen ? ["--build-context", `frozen=${context}`] : []), ".",
  ];
  try {
    docker(args);
  } finally {
    try { docker(["image", "rm", tag]); } catch { /* preserve the build result */ }
  }
}
console.log("clean-cache container builds passed: pinned local bases, frozen context, no cache, no network, and pull=false");
