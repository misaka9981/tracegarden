import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import type { Pool } from "pg";
import {
  DEFAULT_LOCAL_BOOTSTRAP,
  WORKSPACE_ID,
  capabilitiesForRole,
  configuredBootstrapIdentity,
  createBetterAuthRuntime,
  googleOAuthConfig,
  identityKey,
  normalizeEmail,
  type AdmissionResult,
  type AdmissionStore,
  type AuthSession,
  type AuthenticatedSession,
  type BetterAuthRuntime,
  type BootstrapIdentity,
  type ExternalIdentity,
  type MemberRecord,
  type Role,
  validateExternalIdentity,
} from "../../identity/src/index.js";
import { randomUUID } from "node:crypto";

export type DatabaseStatus = "ready" | "not-ready";

export interface DatabaseBoundary {
  readonly kind: "postgres" | "memory";
  readonly admission?: AdmissionStore;
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const FOUNDATION_MIGRATION_ID = "0001_foundation";
export const ADMISSION_MIGRATION_ID = "0002_workspace_admission";
export const BETTER_AUTH_MIGRATION_ID = "0003_better_auth";

type Migration = Readonly<{ id: string; path: string }>;

const migrations: readonly Migration[] = [
  { id: FOUNDATION_MIGRATION_ID, path: "../migrations/0001_foundation.sql" },
  { id: ADMISSION_MIGRATION_ID, path: "../migrations/0002_workspace_admission.sql" },
  { id: BETTER_AUTH_MIGRATION_ID, path: "../migrations/0003_better_auth.sql" },
];

function sessionForMember(member: MemberRecord, authSession?: AuthSession): AuthenticatedSession {
  return {
    token: authSession?.token ?? randomUUID(),
    expiresAt: authSession?.expiresAt ?? new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    member,
  };
}

export class MemoryAdmissionStore implements AdmissionStore {
  private readonly identities = new Map<string, { identity: ExternalIdentity; member: MemberRecord }>();
  private readonly sessions = new Map<string, AuthenticatedSession>();
  private readonly invitations = new Set<string>();

  constructor(private readonly bootstrapIdentity: BootstrapIdentity = DEFAULT_LOCAL_BOOTSTRAP) {}

  async admit(identity: ExternalIdentity, authSession?: AuthSession): Promise<AdmissionResult> {
    if (!validateExternalIdentity(identity)) return { admitted: false, reason: "invalid_identity" };
    const key = identityKey(identity);
    const existing = this.identities.get(key);
    if (existing) {
      const member: MemberRecord = { ...existing.member, identity };
      this.identities.set(key, { identity, member });
      for (const [token, existingSession] of this.sessions) {
        if (existingSession.member.id === member.id) this.sessions.set(token, { ...existingSession, member });
      }
      const session = sessionForMember(member, authSession);
      this.sessions.set(session.token, session);
      return { admitted: true, session };
    }

    let role: Role | undefined;
    if (this.identities.size === 0 && identityKey(identity) === identityKey(this.bootstrapIdentity)) role = "owner";
    else if (this.invitations.delete(normalizeEmail(identity.email))) role = "viewer";
    if (!role) return { admitted: false, reason: "admission_required" };

    const member: MemberRecord = {
      id: randomUUID(),
      workspaceId: WORKSPACE_ID,
      identity,
      role,
      capabilities: capabilitiesForRole(role),
    };
    this.identities.set(key, { identity, member });
    const session = sessionForMember(member, authSession);
    this.sessions.set(session.token, session);
    return { admitted: true, session };
  }

  async getSession(token: string): Promise<AuthenticatedSession | null> {
    const session = this.sessions.get(token);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) {
      if (session) this.sessions.delete(token);
      return null;
    }
    return session;
  }

  async createInvitation(email: string): Promise<void> {
    this.invitations.add(normalizeEmail(email));
  }

  memberCount(): number {
    return this.identities.size;
  }
}

type PoolProvider = () => Promise<Pool>;
type MemberRow = Readonly<{
  member_id: string;
  workspace_id: string;
  role: Role;
  identity_id: string;
  issuer: string;
  subject: string;
  email: string;
  display_name: string;
  expires_at?: string | Date;
  capabilities?: string[];
}>;

function memberFromRow(row: MemberRow): MemberRecord {
  const roleCapabilities = capabilitiesForRole(row.role);
  const capabilities = row.capabilities?.filter((value): value is MemberRecord["capabilities"][number] => roleCapabilities.includes(value as MemberRecord["capabilities"][number])) ?? roleCapabilities;
  return {
    id: row.member_id,
    workspaceId: row.workspace_id,
    identity: {
      issuer: row.issuer,
      subject: row.subject,
      email: row.email,
      displayName: row.display_name,
    },
    role: row.role,
    capabilities,
  };
}

export class PostgresAdmissionStore implements AdmissionStore {
  constructor(private readonly poolProvider: PoolProvider, private readonly bootstrapIdentity: BootstrapIdentity = DEFAULT_LOCAL_BOOTSTRAP) {}

  async admit(identity: ExternalIdentity, authSession?: AuthSession): Promise<AdmissionResult> {
    if (!validateExternalIdentity(identity)) return { admitted: false, reason: "invalid_identity" };
    const pool = await this.poolProvider();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [WORKSPACE_ID]);
      await client.query(
        "INSERT INTO tracegarden_workspaces (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
        [WORKSPACE_ID, "Tracegarden Workspace"],
      );
      const existing = await client.query<MemberRow>(
        `SELECT m.id AS member_id, m.workspace_id, m.role,
                ei.id AS identity_id, ei.issuer, ei.subject, ei.email, ei.display_name
           FROM tracegarden_members m
           JOIN tracegarden_external_identities ei ON ei.id = m.external_identity_id
          WHERE ei.issuer = $1 AND ei.subject = $2`,
        [identity.issuer, identity.subject],
      );
      let member: MemberRecord;
      if (existing.rows[0]) {
        await client.query(
          "UPDATE tracegarden_external_identities SET email = $1, display_name = $2, updated_at = now() WHERE id = $3",
          [identity.email, identity.displayName, existing.rows[0].identity_id],
        );
        member = memberFromRow({ ...existing.rows[0], email: identity.email, display_name: identity.displayName });
      } else {
        const members = await client.query<{ id: string }>(
          "SELECT id FROM tracegarden_members WHERE workspace_id = $1 LIMIT 1",
          [WORKSPACE_ID],
        );
        let role: Role;
        if (members.rows.length === 0 && identityKey(identity) === identityKey(this.bootstrapIdentity)) {
          role = "owner";
        } else {
          const invitation = await client.query<{ id: string }>(
            `SELECT id FROM tracegarden_invitations
              WHERE workspace_id = $1 AND email_key = $2
                AND revoked_at IS NULL AND accepted_at IS NULL
              ORDER BY created_at
              LIMIT 1`,
            [WORKSPACE_ID, normalizeEmail(identity.email)],
          );
          if (!invitation.rows[0]) {
            await client.query("COMMIT");
            return { admitted: false, reason: "admission_required" };
          }
          role = "viewer";
          await client.query("UPDATE tracegarden_invitations SET accepted_at = now() WHERE id = $1", [invitation.rows[0].id]);
        }
        const identityId = randomUUID();
        await client.query(
          `INSERT INTO tracegarden_external_identities (id, issuer, subject, email, display_name)
           VALUES ($1, $2, $3, $4, $5)`,
          [identityId, identity.issuer, identity.subject, identity.email, identity.displayName],
        );
        const memberId = randomUUID();
        await client.query(
          `INSERT INTO tracegarden_members (id, workspace_id, external_identity_id, role)
           VALUES ($1, $2, $3, $4)`,
          [memberId, WORKSPACE_ID, identityId, role],
        );
        member = {
          id: memberId,
          workspaceId: WORKSPACE_ID,
          identity,
          role,
          capabilities: capabilitiesForRole(role),
        };
      }
      const session = sessionForMember(member, authSession);
      if (!authSession) {
        await client.query(
          `INSERT INTO tracegarden_sessions (id, token, member_id, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [randomUUID(), session.token, member.id, session.expiresAt],
        );
      }
      await client.query("COMMIT");
      return { admitted: true, session };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error("Tracegarden admission persistence failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async getSession(token: string): Promise<AuthenticatedSession | null> {
    const pool = await this.poolProvider();
    const result = await pool.query<MemberRow>(
      `SELECT m.id AS member_id, m.workspace_id, m.role, s.expires_at,
              ei.id AS identity_id, ei.issuer, ei.subject, ei.email, ei.display_name,
              COALESCE(array_agg(rc.capability) FILTER (WHERE rc.capability IS NOT NULL), '{}') AS capabilities
         FROM tracegarden_sessions s
         JOIN tracegarden_members m ON m.id = s.member_id
         JOIN tracegarden_external_identities ei ON ei.id = m.external_identity_id
         LEFT JOIN tracegarden_role_capabilities rc ON rc.role = m.role
        WHERE s.token = $1 AND s.expires_at > now()
        GROUP BY s.id, m.id, ei.id`,
      [token],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      token,
      expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at ?? new Date(0).toISOString(),
      member: memberFromRow(row),
    };
  }

  async createInvitation(email: string): Promise<void> {
    const pool = await this.poolProvider();
    await pool.query(
      `INSERT INTO tracegarden_invitations (id, workspace_id, email, email_key)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), WORKSPACE_ID, email.trim(), normalizeEmail(email)],
    );
  }
}

export class PostgresDatabase implements DatabaseBoundary {
  readonly kind = "postgres" as const;
  private pool: Pool | undefined;
  readonly admission: AdmissionStore;

  constructor(private readonly connectionString: string, bootstrapIdentity: BootstrapIdentity = DEFAULT_LOCAL_BOOTSTRAP) {
    this.admission = new PostgresAdmissionStore(() => this.getPool(), bootstrapIdentity);
  }

  private async getPool(): Promise<Pool> {
    if (this.pool) return this.pool;
    const { Pool: PgPool } = await import("pg");
    this.pool = new PgPool({ connectionString: this.connectionString, max: 5 });
    return this.pool;
  }

  async betterAuth(environment: Record<string, string | undefined>): Promise<BetterAuthRuntime> {
    const config = googleOAuthConfig(environment);
    const baseURL = environment.BETTER_AUTH_URL?.trim();
    if (!baseURL) throw new Error("BETTER_AUTH_URL is required in production");
    try {
      const url = new URL(baseURL);
      const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
      if (url.protocol !== "https:" && !(environment.NODE_ENV === "test" && loopback && url.protocol === "http:")) {
        throw new Error("insecure production URL");
      }
    } catch {
      throw new Error("BETTER_AUTH_URL must be HTTPS in production");
    }
    return createBetterAuthRuntime(config, await this.getPool(), baseURL, environment.BETTER_AUTH_SECRET?.trim() ?? "");
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
      for (const migration of migrations) {
        const applied = await pool.query<{ id: string }>(
          "SELECT id FROM tracegarden_schema_migrations WHERE id = $1",
          [migration.id],
        );
        if (applied.rows.length > 0) continue;
        const migrationPath = fileURLToPath(new URL(migration.path, import.meta.url));
        const migrationSql = await readFile(migrationPath, "utf8");
        await pool.query(migrationSql);
        await pool.query(
          "INSERT INTO tracegarden_schema_migrations (id) VALUES ($1)",
          [migration.id],
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
  readonly admission: MemoryAdmissionStore;
  private migrationReady = false;

  constructor(bootstrapIdentity: BootstrapIdentity = DEFAULT_LOCAL_BOOTSTRAP) {
    this.admission = new MemoryAdmissionStore(bootstrapIdentity);
  }

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
  const bootstrapIdentity = environment.NODE_ENV === "production" ? configuredBootstrapIdentity(environment) : DEFAULT_LOCAL_BOOTSTRAP;
  return new PostgresDatabase(connectionString, bootstrapIdentity);
}
