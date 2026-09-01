import { PostgresDatabase } from "../../../packages/db/src/index.js";

function positiveSeconds(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function waitForDatabase(database: PostgresDatabase): Promise<void> {
  const timeoutSeconds = positiveSeconds("MIGRATION_DATABASE_READY_TIMEOUT_SECONDS", 120);
  const retrySeconds = positiveSeconds("MIGRATION_DATABASE_READY_RETRY_SECONDS", 2);
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (true) {
    if (await database.ping()) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("Tracegarden database readiness timeout");
    await new Promise((resolve) => setTimeout(resolve, Math.min(retrySeconds * 1000, remainingMs)));
  }
}

function parseDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!url.hostname || !["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("unsupported protocol");
    return value;
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
}

const configuredUrl = process.env.DATABASE_URL?.trim();
if (!configuredUrl) {
  console.error("DATABASE_URL is required for the migration gate");
  process.exitCode = 1;
} else {
  try {
    const database = new PostgresDatabase(parseDatabaseUrl(configuredUrl));
    try {
      await waitForDatabase(database);
      await database.migrate();
      console.log("Tracegarden migrations applied");
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : "Tracegarden migrations failed");
      process.exitCode = 1;
    } finally {
      await database.close();
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "Tracegarden migrations failed");
    process.exitCode = 1;
  }
}
