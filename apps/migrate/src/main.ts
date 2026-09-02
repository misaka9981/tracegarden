import { PostgresDatabase, waitForDatabase } from "../../../packages/db/src/index.js";

function positiveSeconds(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
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
      await waitForDatabase(
        database,
        positiveSeconds("MIGRATION_DATABASE_READY_TIMEOUT_SECONDS", 120) * 1000,
        positiveSeconds("MIGRATION_DATABASE_READY_RETRY_SECONDS", 2) * 1000,
      );
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
