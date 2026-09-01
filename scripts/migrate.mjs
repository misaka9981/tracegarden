import { createDatabase } from "../dist/packages/db/src/index.js";

const database = createDatabase(process.env);
try {
  await database.migrate();
  console.log("database migrations applied");
} finally {
  await database.close();
}
