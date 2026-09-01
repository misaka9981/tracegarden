const [major, minor] = process.versions.node.split(".").map(Number);
const failures = [];
if (major !== 26 || minor !== 8) failures.push(`Node.js 26.8.x is required (found ${process.version})`);
if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) failures.push("DATABASE_URL is required in production");
if (process.env.DATABASE_MODE === "memory" && process.env.NODE_ENV !== "test") failures.push("DATABASE_MODE=memory is restricted to test runs");
if (process.env.DATABASE_URL?.startsWith("postgres://") || process.env.DATABASE_URL?.startsWith("postgresql://")) {
  console.log("DATABASE_URL is configured without printing its value");
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`environment valid: Node.js ${process.version}`);
}
