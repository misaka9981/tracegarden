import { PostgresDatabase } from "../../../packages/db/src/index.js";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error("DATABASE_URL is required for the migration gate");
  process.exitCode = 1;
} else {
  const database = new PostgresDatabase(connectionString);
  try {
    await database.migrate();
    console.log("Tracegarden migrations applied");
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "Tracegarden migrations failed");
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}
