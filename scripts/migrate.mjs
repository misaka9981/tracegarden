import { PostgresDatabase } from "../dist/packages/db/src/index.js";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required for migrations");

const database = new PostgresDatabase(connectionString);
try {
  await database.migrate();
  console.log("database migrations applied");
} finally {
  await database.close();
}
