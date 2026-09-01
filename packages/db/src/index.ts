import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import type { Pool } from "pg";
import {
  DEFAULT_LOCAL_BOOTSTRAP,
  WORKSPACE_ID,
  capabilities,
  capabilitiesForRole,
  configuredBootstrapIdentity,
  createBetterAuthRuntime,
  googleOAuthConfig,
  identityKey,
  isRole,
  normalizeEmail,
  normalizeInvitationEmail,
  requireCapability,
  type AdmissionResult,
  type AdmissionStore,
  type AuditAction,
  type AuditRecord,
  type AuditTargetType,
  type AuthSession,
  type AuthenticatedSession,
  type BetterAuthRuntime,
  type BootstrapIdentity,
  type ExternalIdentity,
  type InvitationRecord,
  type MemberRecord,
  type MembershipActor,
  type MembershipStore,
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
export const MEMBERSHIP_MIGRATION_ID = "0004_membership_management";

type Migration = Readonly<{ id: string; path: string }>;

const migrations: readonly Migration[] = [
  { id: FOUNDATION_MIGRATION_ID, path: "../migrations/0001_foundation.sql" },
  { id: ADMISSION_MIGRATION_ID, path: "../migrations/0002_workspace_admission.sql" },
  { id: BETTER_AUTH_MIGRATION_ID, path: "../migrations/0003_better_auth.sql" },
  { id: MEMBERSHIP_MIGRATION_ID, path: "../migrations/0004_membership_management.sql" },
];

function sessionForMember(member: MemberRecord, authSession?: AuthSession): AuthenticatedSession {
  return {
    token: authSession?.token ?? randomUUID(),
    expiresAt: authSession?.expiresAt ?? new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    member,
  };
}

export class MemoryAdmissionStore implements AdmissionStore, MembershipStore {
  private readonly identities = new Map<string, { identity: ExternalIdentity; member: MemberRecord }>();
  private readonly sessions = new Map<string, AuthenticatedSession>();
  private readonly invitations = new Map<string, InvitationRecord>();
  private readonly audits: AuditRecord[] = [];

  constructor(private readonly bootstrapIdentity: BootstrapIdentity = DEFAULT_LOCAL_BOOTSTRAP) {}

  private assertCanManage(actor: MembershipActor): void {
    if (!actor || !actor.id.trim()) throw new Error("Membership actor is required");
    requireCapability(actor, capabilities.membershipManage);
  }

  private audit(
    action: AuditAction,
    targetType: AuditTargetType,
    targetId: string,
    actorMemberId: string | null,
    metadata: Record<string, string>,
  ): void {
    this.audits.push(Object.freeze({
      id: randomUUID(),
      workspaceId: WORKSPACE_ID,
      actorMemberId,
      action,
      targetType,
      targetId,
      metadata: Object.freeze({ ...metadata }),
      createdAt: new Date().toISOString(),
    }));
  }

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
    let invitation: InvitationRecord | undefined;
    if (this.identities.size === 0 && identityKey(identity) === identityKey(this.bootstrapIdentity)) {
      role = "owner";
    } else {
      const email = normalizeEmail(identity.email);
      invitation = [...this.invitations.values()].find((candidate) => candidate.email === email && !candidate.revokedAt && !candidate.acceptedAt);
      if (invitation) role = "viewer";
    }
    if (!role) return { admitted: false, reason: "admission_required" };

    const now = new Date().toISOString();
    if (invitation) {
      const accepted: InvitationRecord = { ...invitation, acceptedAt: now };
      this.invitations.set(invitation.id, accepted);
    }
    const member: MemberRecord = {
      id: randomUUID(),
      workspaceId: WORKSPACE_ID,
      identity,
      role,
      capabilities: capabilitiesForRole(role),
    };
    this.identities.set(key, { identity, member });
    this.audit("member.admitted", "member", member.id, null, {
      email: normalizeEmail(identity.email),
      role,
      ...(invitation ? { invitationId: invitation.id } : {}),
    });
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

  async createInvitation(email: string, actor: MembershipActor): Promise<InvitationRecord> {
    this.assertCanManage(actor);
    const normalizedEmail = normalizeInvitationEmail(email);
    const invitation: InvitationRecord = {
      id: randomUUID(),
      workspaceId: WORKSPACE_ID,
      email: normalizedEmail,
      createdAt: new Date().toISOString(),
      revokedAt: null,
      acceptedAt: null,
    };
    this.invitations.set(invitation.id, invitation);
    this.audit("invitation.created", "invitation", invitation.id, actor.id, { email: normalizedEmail });
    return invitation;
  }

  async revokeInvitation(id: string, actor: MembershipActor): Promise<InvitationRecord | null> {
    this.assertCanManage(actor);
    const invitation = this.invitations.get(id);
    if (!invitation || invitation.revokedAt || invitation.acceptedAt) return null;
    const revoked: InvitationRecord = { ...invitation, revokedAt: new Date().toISOString() };
    this.invitations.set(id, revoked);
    this.audit("invitation.revoked", "invitation", id, actor.id, { email: invitation.email });
    return revoked;
  }

  async listInvitations(): Promise<readonly InvitationRecord[]> {
    return Object.freeze([...this.invitations.values()].map((invitation) => ({ ...invitation })));
  }

  async listMembers(): Promise<readonly MemberRecord[]> {
    return Object.freeze([...this.identities.values()].map(({ member }) => ({
      ...member,
      identity: { ...member.identity },
      capabilities: [...member.capabilities],
    })));
  }

  async assignMemberRole(memberId: string, role: Role, actor: MembershipActor): Promise<MemberRecord | null> {
    this.assertCanManage(actor);
    if (!isRole(role)) throw new Error("Unknown member role");
    const entry = [...this.identities.entries()].find(([, value]) => value.member.id === memberId);
    if (!entry) return null;
    const [key, current] = entry;
    if (current.member.role === role) return current.member;
    const member: MemberRecord = { ...current.member, role, capabilities: capabilitiesForRole(role) };
    this.identities.set(key, { identity: current.identity, member });
    for (const [token, session] of this.sessions) {
      if (session.member.id === memberId) this.sessions.set(token, { ...session, member });
    }
    this.audit("member.role_changed", "member", memberId, actor.id, {
      fromRole: current.member.role,
      toRole: role,
    });
    return member;
  }

  async listAuditRecords(): Promise<readonly AuditRecord[]> {
    return Object.freeze(this.audits.map((audit) => ({ ...audit, metadata: { ...audit.metadata } })));
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

type InvitationRow = Readonly<{
  id: string;
  workspace_id: string;
  email: string;
  created_at: string | Date;
  revoked_at?: string | Date | null;
  accepted_at?: string | Date | null;
}>;

type AuditRow = Readonly<{
  id: string;
  workspace_id: string;
  actor_member_id?: string | null;
  action: AuditAction;
  target_type: AuditTargetType;
  target_id: string;
  metadata: Record<string, unknown>;
  created_at: string | Date;
}>;

function timestamp(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function invitationFromRow(row: InvitationRow): InvitationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: normalizeEmail(row.email),
    createdAt: timestamp(row.created_at) ?? new Date(0).toISOString(),
    revokedAt: timestamp(row.revoked_at),
    acceptedAt: timestamp(row.accepted_at),
  };
}

function auditFromRow(row: AuditRow): AuditRecord {
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.metadata)) {
    if (typeof value === "string") metadata[key] = value;
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actorMemberId: row.actor_member_id ?? null,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata,
    createdAt: timestamp(row.created_at) ?? new Date(0).toISOString(),
  };
}

export class PostgresAdmissionStore implements AdmissionStore, MembershipStore {
  constructor(private readonly poolProvider: PoolProvider, private readonly bootstrapIdentity: BootstrapIdentity = DEFAULT_LOCAL_BOOTSTRAP) {}

  private assertCanManage(actor: MembershipActor): void {
    if (!actor || !actor.id.trim()) throw new Error("Membership actor is required");
    requireCapability(actor, capabilities.membershipManage);
  }

  private async audit(
    client: { query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }> },
    action: AuditAction,
    targetType: AuditTargetType,
    targetId: string,
    actorMemberId: string | null,
    metadata: Record<string, string>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO tracegarden_audit_records
         (id, workspace_id, actor_member_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [randomUUID(), WORKSPACE_ID, actorMemberId, action, targetType, targetId, JSON.stringify(metadata)],
    );
  }

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
      let admissionInvitationId: string | undefined;
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
          admissionInvitationId = invitation.rows[0].id;
          const accepted = await client.query("UPDATE tracegarden_invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL", [invitation.rows[0].id]);
          if (accepted.rowCount !== 1) {
            await client.query("ROLLBACK");
            return { admitted: false, reason: "admission_required" };
          }
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
        await this.audit(client, "member.admitted", "member", member.id, null, {
          email: normalizeEmail(identity.email),
          role,
          ...(admissionInvitationId ? { invitationId: admissionInvitationId } : {}),
        });
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

  async createInvitation(email: string, actor: MembershipActor): Promise<InvitationRecord> {
    this.assertCanManage(actor);
    const normalizedEmail = normalizeInvitationEmail(email);
    const pool = await this.poolProvider();
    const client = await pool.connect();
    const id = randomUUID();
    try {
      await client.query("BEGIN");
      const result = await client.query<InvitationRow>(
        `INSERT INTO tracegarden_invitations (id, workspace_id, email, email_key)
         VALUES ($1, $2, $3, $3)
         RETURNING id, workspace_id, email, created_at, revoked_at, accepted_at`,
        [id, WORKSPACE_ID, normalizedEmail],
      );
      const invitation = invitationFromRow(result.rows[0] ?? {
        id,
        workspace_id: WORKSPACE_ID,
        email: normalizedEmail,
        created_at: new Date().toISOString(),
        revoked_at: null,
        accepted_at: null,
      });
      await this.audit(client, "invitation.created", "invitation", invitation.id, actor.id, { email: normalizedEmail });
      await client.query("COMMIT");
      return invitation;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error("Tracegarden invitation creation failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async revokeInvitation(id: string, actor: MembershipActor): Promise<InvitationRecord | null> {
    this.assertCanManage(actor);
    const pool = await this.poolProvider();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<InvitationRow>(
        `UPDATE tracegarden_invitations
            SET revoked_at = now()
          WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL AND accepted_at IS NULL
        RETURNING id, workspace_id, email, created_at, revoked_at, accepted_at`,
        [id, WORKSPACE_ID],
      );
      if (!result.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const invitation = invitationFromRow(result.rows[0]);
      await this.audit(client, "invitation.revoked", "invitation", id, actor.id, { email: invitation.email });
      await client.query("COMMIT");
      return invitation;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error("Tracegarden invitation revocation failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async listInvitations(): Promise<readonly InvitationRecord[]> {
    const pool = await this.poolProvider();
    const result = await pool.query<InvitationRow>(
      `SELECT id, workspace_id, email, created_at, revoked_at, accepted_at
         FROM tracegarden_invitations
        WHERE workspace_id = $1
        ORDER BY created_at, id`,
      [WORKSPACE_ID],
    );
    return Object.freeze(result.rows.map(invitationFromRow));
  }

  async listMembers(): Promise<readonly MemberRecord[]> {
    const pool = await this.poolProvider();
    const result = await pool.query<MemberRow>(
      `SELECT m.id AS member_id, m.workspace_id, m.role,
              ei.id AS identity_id, ei.issuer, ei.subject, ei.email, ei.display_name,
              COALESCE(array_agg(rc.capability) FILTER (WHERE rc.capability IS NOT NULL), '{}') AS capabilities
         FROM tracegarden_members m
         JOIN tracegarden_external_identities ei ON ei.id = m.external_identity_id
         LEFT JOIN tracegarden_role_capabilities rc ON rc.role = m.role
        WHERE m.workspace_id = $1
        GROUP BY m.id, ei.id
        ORDER BY m.created_at, m.id`,
      [WORKSPACE_ID],
    );
    return Object.freeze(result.rows.map(memberFromRow));
  }

  async assignMemberRole(memberId: string, role: Role, actor: MembershipActor): Promise<MemberRecord | null> {
    this.assertCanManage(actor);
    if (!isRole(role)) throw new Error("Unknown member role");
    const pool = await this.poolProvider();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query<MemberRow>(
        `SELECT m.id AS member_id, m.workspace_id, m.role,
                ei.id AS identity_id, ei.issuer, ei.subject, ei.email, ei.display_name
           FROM tracegarden_members m
           JOIN tracegarden_external_identities ei ON ei.id = m.external_identity_id
          WHERE m.id = $1 AND m.workspace_id = $2
          FOR UPDATE`,
        [memberId, WORKSPACE_ID],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow) {
        await client.query("COMMIT");
        return null;
      }
      if (currentRow.role === role) {
        await client.query("COMMIT");
        return memberFromRow(currentRow);
      }
      await client.query("UPDATE tracegarden_members SET role = $1 WHERE id = $2", [role, memberId]);
      await this.audit(client, "member.role_changed", "member", memberId, actor.id, {
        fromRole: currentRow.role,
        toRole: role,
      });
      await client.query("COMMIT");
      return memberFromRow({ ...currentRow, role });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error("Tracegarden member role update failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async listAuditRecords(): Promise<readonly AuditRecord[]> {
    const pool = await this.poolProvider();
    const result = await pool.query<AuditRow>(
      `SELECT id, workspace_id, actor_member_id, action, target_type, target_id, metadata, created_at
         FROM tracegarden_audit_records
        WHERE workspace_id = $1
        ORDER BY created_at, id`,
      [WORKSPACE_ID],
    );
    return Object.freeze(result.rows.map(auditFromRow));
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
