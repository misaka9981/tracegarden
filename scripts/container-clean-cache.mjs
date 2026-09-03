import { execFileSync } from "node:child_process";

const context = process.env.TRACEGARDEN_CONTAINER_CONTEXT?.trim() || ".scratch/container-context";
const bunImage = "docker.io/oven/bun:1.4.0-distroless@sha256:76caa97ddc0e01333d98c6ab5499539dad4bbceae6237eac83e7853d3826b981";
const bunUser = "nonroot";
const bunVersion = "1.4.0";
const noNodeRuntime = "const fs=process.getBuiltinModule('node:fs'); if (fs.existsSync('/usr/local/bin/node') || Bun.which('node')) process.exit(1)";
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
function dockerOutput(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function requireImage(image) {
  try {
    docker(["image", "inspect", image]);
  } catch (error) {
    throw new Error(`clean-cache build requires the preloaded pinned image ${image}`, { cause: error });
  }
}

requireImage(bunImage);
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
    if (service === "collector" || service === "migrate") {
      if (dockerOutput(["image", "inspect", "-f", "{{.Config.User}}", tag]) !== bunUser) {
        throw new Error(`clean-cache ${service} image must use the non-root ${bunUser} user`);
      }
      if (dockerOutput(["image", "inspect", "-f", "{{.Architecture}}", tag]) !== "arm64") {
        throw new Error(`clean-cache ${service} image must be ARM64`);
      }
      const runArgs = [
        "run", "--rm", "--pull=never", "--platform", "linux/arm64", "--read-only", "--user", bunUser,
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--cap-drop", "ALL",
      ];
      if (dockerOutput([...runArgs, "--entrypoint", "bun", tag, "--version"]) !== bunVersion) {
        throw new Error(`clean-cache ${service} image must run Bun ${bunVersion}`);
      }
      if (dockerOutput([...runArgs, "--entrypoint", "bun", tag, "--eval", noNodeRuntime]) !== "") {
        throw new Error(`clean-cache ${service} image must not contain a Node runtime`);
      }
    }
    if (service === "backup") {
      if (dockerOutput(["image", "inspect", "-f", "{{.Config.User}}", tag]) !== bunUser) {
        throw new Error(`clean-cache backup image must use the non-root ${bunUser} user`);
      }
      if (dockerOutput(["image", "inspect", "-f", "{{.Architecture}}", tag]) !== "arm64") {
        throw new Error("clean-cache backup image must be ARM64");
      }
      const runArgs = [
        "run", "--rm", "--pull=never", "--platform", "linux/arm64", "--read-only", "--user", bunUser,
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--cap-drop", "ALL",
      ];
      const uid = dockerOutput([...runArgs, "--entrypoint", "bun", tag, "--eval", "console.log(process.getuid())"]);
      if (!/^[1-9]\d*$/.test(uid)) throw new Error("clean-cache backup image must run with a non-root effective UID");
      if (dockerOutput([...runArgs, "--entrypoint", "bun", tag, "--version"]) !== bunVersion) {
        throw new Error(`clean-cache backup image must run Bun ${bunVersion}`);
      }
      if (dockerOutput([...runArgs, "--entrypoint", "bun", tag, "--eval", noNodeRuntime]) !== "") {
        throw new Error("clean-cache backup image must not contain a Node runtime");
      }
      for (const binary of ["pg_dump", "pg_restore"]) {
        const version = dockerOutput([...runArgs, "--entrypoint", binary, tag, "--version"]);
        if (version !== `${binary} (PostgreSQL) 18.3`) throw new Error(`clean-cache backup image failed ${binary} --version`);
      }
    }
  } finally {
    try { docker(["image", "rm", tag]); } catch { /* preserve the build result */ }
  }
}
console.log("clean-cache container builds and backup runtime smoke passed: pinned local bases, frozen context, no cache, no network, pull=false, and pull-never");
