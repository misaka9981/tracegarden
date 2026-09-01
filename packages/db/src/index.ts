import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

export type DatabaseStatus = "ready" | "not-ready";

export interface DatabaseBoundary {
  readonly kind: "postgres" | "memory";
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const FOUNDATION_MIGRATION_ID = "0001_foundation";

export class PostgresDatabase implements DatabaseBoundary {
  readonly kind = "postgres" as const;
  private pool: Pool | undefined;

  constructor(private readonly connectionString: string) {}

  private async getPool(): Promise<Pool> {
    if (this.pool) return this.pool;
    const { Pool: PgPool } = await import("pg");
    this.pool = new PgPool({ connectionString: this.connectionString, max: 5 });
    return this.pool;
  }

  async migrate(): Promise<void> {
    const pool = await this.getPool();
    await pool.query("BEGIN");
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tracegarden_schema_migrations (
          id text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      const applied = await pool.query<{ id: string }>(
        "SELECT id FROM tracegarden_schema_migrations WHERE id = $1",
        [FOUNDATION_MIGRATION_ID],
      );
      if (applied.rows.length === 0) {
        const migrationPath = fileURLToPath(new URL("../migrations/0001_foundation.sql", import.meta.url));
        const migrationSql = await readFile(migrationPath, "utf8");
        await pool.query(migrationSql);
        await pool.query(
          "INSERT INTO tracegarden_schema_migrations (id) VALUES ($1)",
          [FOUNDATION_MIGRATION_ID],
        );
      }
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK").catch(() => undefined);
      await this.close();
      throw new Error("Tracegarden database migration failed", { cause: error });
    }
  }

  async ping(): Promise<boolean> {
    try {
      const pool = await this.getPool();
      await pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}

export class MemoryDatabase implements DatabaseBoundary {
  readonly kind = "memory" as const;
  private migrationReady = false;

  async migrate(): Promise<void> {
    this.migrationReady = true;
  }

  async ping(): Promise<boolean> {
    return this.migrationReady;
  }

  async close(): Promise<void> {}
}

export function createDatabase(environment: Record<string, string | undefined>): DatabaseBoundary {
  if (environment.DATABASE_MODE === "memory") {
    if (environment.NODE_ENV !== "test") {
      throw new Error("DATABASE_MODE=memory is restricted to test runs");
    }
    return new MemoryDatabase();
  }
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required; use DATABASE_MODE=memory only for local smoke tests");
  }
  return new PostgresDatabase(connectionString);
}
