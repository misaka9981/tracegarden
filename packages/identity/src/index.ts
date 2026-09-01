import { betterAuth, type BetterAuthOptions } from "better-auth";

export const WORKSPACE_ID = "workspace-single";
export const GOOGLE_ISSUER = "https://accounts.google.com";

export const capabilities = {
  workspaceRead: "workspace:read",
  membershipManage: "membership:manage",
  timelineRead: "timeline:read",
  experimentWrite: "experiment:write",
  clusterConfigure: "cluster:configure",
  logsRead: "logs:read",
  correlationReview: "correlation:review",
} as const;

export type Capability = (typeof capabilities)[keyof typeof capabilities];
export type Role = "owner" | "operator" | "viewer";

export const roleCapabilities: Readonly<Record<Role, readonly Capability[]>> = {
  owner: [capabilities.workspaceRead, capabilities.membershipManage, capabilities.timelineRead, capabilities.experimentWrite, capabilities.clusterConfigure, capabilities.logsRead, capabilities.correlationReview],
  operator: [capabilities.workspaceRead, capabilities.timelineRead, capabilities.experimentWrite, capabilities.correlationReview],
  viewer: [capabilities.workspaceRead, capabilities.timelineRead],
};

export type ExternalIdentity = Readonly<{
  issuer: string;
  subject: string;
  email: string;
  displayName: string;
}>;

export type BootstrapIdentity = Readonly<Pick<ExternalIdentity, "issuer" | "subject">>;

export const DEFAULT_LOCAL_BOOTSTRAP: BootstrapIdentity = {
  issuer: "https://local.tracegarden.test",
  subject: "owner",
};

export function configuredBootstrapIdentity(environment: Record<string, string | undefined>): BootstrapIdentity {
  const issuer = environment.TRACEGARDEN_BOOTSTRAP_ISSUER?.trim();
  const subject = environment.TRACEGARDEN_BOOTSTRAP_SUBJECT?.trim();
  if (!issuer || !subject) {
    throw new Error("TRACEGARDEN_BOOTSTRAP_ISSUER and TRACEGARDEN_BOOTSTRAP_SUBJECT are required");
  }
  return { issuer, subject };
}

export type AuthSession = Readonly<{
  token: string;
  expiresAt: string;
}>;

export type MemberRecord = Readonly<{
  id: string;
  workspaceId: string;
  identity: ExternalIdentity;
  role: Role;
  capabilities: readonly Capability[];
}>;

export type MembershipActor = Pick<MemberRecord, "id" | "capabilities">;

export type InvitationRecord = Readonly<{
  id: string;
  workspaceId: string;
  email: string;
  createdAt: string;
  revokedAt: string | null;
  acceptedAt: string | null;
}>;

export type LogAccessAuditMetadata = Readonly<{
  clusterId: string;
  namespace: string;
  pod: string;
  container: string;
  tail: string;
  lineCount: string;
  byteCount: string;
}>;

export interface LogAuditStore {
  recordLogAccess(actor: Pick<MemberRecord, "id">, metadata: LogAccessAuditMetadata): Promise<void>;
}

export type AuditAction = "invitation.created" | "invitation.revoked" | "member.admitted" | "member.role_changed" | "log.accessed";
export type AuditTargetType = "invitation" | "member" | "log_window";
export type AuditRecord = Readonly<{
  id: string;
  workspaceId: string;
  actorMemberId: string | null;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  metadata: Readonly<Record<string, string>>;
  createdAt: string;
}>;

export interface MembershipStore {
  createInvitation(email: string, actor: MembershipActor): Promise<InvitationRecord>;
  revokeInvitation(id: string, actor: MembershipActor): Promise<InvitationRecord | null>;
  listInvitations(): Promise<readonly InvitationRecord[]>;
  listMembers(): Promise<readonly MemberRecord[]>;
  assignMemberRole(memberId: string, role: Role, actor: MembershipActor): Promise<MemberRecord | null>;
  listAuditRecords(): Promise<readonly AuditRecord[]>;
}

export type AuthenticatedSession = Readonly<{
  token: string;
  expiresAt: string;
  member: MemberRecord;
}>;

export type AdmissionResult =
  | Readonly<{ admitted: true; session: AuthenticatedSession }>
  | Readonly<{ admitted: false; reason: "admission_required" | "invalid_identity" }>;

export interface AdmissionStore {
  admit(identity: ExternalIdentity, authSession?: AuthSession): Promise<AdmissionResult>;
  getSession(token: string): Promise<AuthenticatedSession | null>;
  createInvitation?(email: string, actor: MembershipActor): Promise<InvitationRecord | void>;
  revokeInvitation?(id: string, actor: MembershipActor): Promise<InvitationRecord | null>;
  listInvitations?(): Promise<readonly InvitationRecord[]>;
  listMembers?(): Promise<readonly MemberRecord[]>;
  assignMemberRole?(memberId: string, role: Role, actor: MembershipActor): Promise<MemberRecord | null>;
  listAuditRecords?(): Promise<readonly AuditRecord[]>;
}

export type LocalIdentityOption = Readonly<{
  key: string;
  email: string;
  displayName: string;
}>;

export interface IdentityAdapter {
  readonly kind: "local" | "google";
  readonly options: readonly LocalIdentityOption[];
  resolve(selection: string): ExternalIdentity | null;
}

const defaultLocalIdentities: readonly (LocalIdentityOption & { issuer: string; subject: string })[] = [
  {
    key: "owner",
    issuer: DEFAULT_LOCAL_BOOTSTRAP.issuer,
    subject: DEFAULT_LOCAL_BOOTSTRAP.subject,
    email: "owner@example.test",
    displayName: "Tracegarden Owner",
  },
  {
    key: "invited",
    issuer: "https://local.tracegarden.test",
    subject: "invited",
    email: "invited@example.test",
    displayName: "Invited Member",
  },
  {
    key: "rejected",
    issuer: "https://local.tracegarden.test",
    subject: "rejected",
    email: "rejected@example.test",
    displayName: "Rejected Identity",
  },
];

export class LocalIdentityAdapter implements IdentityAdapter {
  readonly kind = "local" as const;
  readonly options: readonly LocalIdentityOption[];
  private readonly identities: ReadonlyMap<string, ExternalIdentity>;

  constructor(definitions: readonly (LocalIdentityOption & { issuer?: string; subject?: string })[] = defaultLocalIdentities) {
    const identities = definitions.map((definition) => {
      const identity: ExternalIdentity = {
        issuer: definition.issuer ?? "https://local.tracegarden.test",
        subject: definition.subject ?? definition.key,
        email: definition.email.trim(),
        displayName: definition.displayName.trim(),
      };
      return [definition.key, identity] as const;
    });
    this.identities = new Map(identities);
    this.options = definitions.map(({ key, email, displayName }) => ({ key, email, displayName }));
  }

  resolve(selection: string): ExternalIdentity | null {
    return this.identities.get(selection) ?? null;
  }
}

export type GoogleOAuthConfig = Readonly<{
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  issuer: string;
}>;

export function googleOAuthConfig(environment: Record<string, string | undefined>): GoogleOAuthConfig {
  const clientId = environment.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = environment.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = environment.GOOGLE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google OAuth requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI");
  }
  try {
    const url = new URL(redirectUri);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw new Error("GOOGLE_REDIRECT_URI must be an absolute HTTP(S) URL");
  }
  return { clientId, clientSecret, redirectUri, issuer: GOOGLE_ISSUER };
}

export type BetterAuthSession = Readonly<{
  token: string;
  expiresAt: string;
  subject: string;
  user: Readonly<{ id: string; email: string; name?: string | null }>;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function dateString(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export type BetterAuthRuntime = Readonly<{
  handler(request: Request): Promise<Response>;
  session(headers: Headers): Promise<BetterAuthSession | null>;
}>;

export async function createBetterAuthRuntime(
  config: GoogleOAuthConfig,
  database: unknown,
  baseURL: string,
  secret: string,
): Promise<BetterAuthRuntime> {
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required in production");
  const auth = betterAuth({
    appName: "Tracegarden",
    baseURL,
    basePath: "/api/auth",
    secret,
    database: database as BetterAuthOptions["database"],
    socialProviders: {
      google: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectURI: config.redirectUri,
      },
    },
  });
  return {
    handler: auth.handler,
    session: async (headers) => {
      const result: unknown = await auth.api.getSession({ headers });
      const resultRecord = record(result);
      const sessionRecord = record(resultRecord?.session);
      const userRecord = record(resultRecord?.user);
      const token = sessionRecord?.token;
      const expiresAt = dateString(sessionRecord?.expiresAt);
      const userId = userRecord?.id;
      const email = userRecord?.email;
      const name = userRecord?.name;
      if (typeof token !== "string" || !token || !expiresAt || typeof userId !== "string" || !userId || typeof email !== "string" || !email) return null;
      if (name !== undefined && name !== null && typeof name !== "string") return null;
      const accounts: unknown = await auth.api.listUserAccounts({ headers });
      if (!Array.isArray(accounts)) return null;
      const googleAccount = (accounts as unknown[]).find((account) => {
        const accountRecord = record(account);
        return accountRecord?.providerId === "google" && typeof accountRecord.accountId === "string" && accountRecord.accountId.trim().length > 0;
      });
      const accountRecord = record(googleAccount);
      const subject = accountRecord?.accountId;
      if (typeof subject !== "string" || !subject.trim()) return null;
      return {
        token,
        expiresAt,
        subject: subject.trim(),
        user: { id: userId, email, ...(name === undefined ? {} : { name }) },
      };
    },
  };
}

export class GoogleIdentityAdapter implements IdentityAdapter {
  readonly kind = "google" as const;
  readonly options: readonly LocalIdentityOption[] = [];

  resolve(): ExternalIdentity | null {
    return null;
  }
}

export function createIdentityAdapter(environment: Record<string, string | undefined>): IdentityAdapter {
  if (environment.NODE_ENV === "production") {
    googleOAuthConfig(environment);
    return new GoogleIdentityAdapter();
  }
  return new LocalIdentityAdapter();
}

export function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase("en-US");
}

export function normalizeInvitationEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Invitation email must be a valid email address");
  }
  return normalized;
}

export function identityKey(identity: Pick<ExternalIdentity, "issuer" | "subject">): string {
  return `${identity.issuer}\u0000${identity.subject}`;
}

export function isRole(value: string): value is Role {
  return value === "owner" || value === "operator" || value === "viewer";
}

export function capabilitiesForRole(role: Role): readonly Capability[] {
  return roleCapabilities[role];
}

export function hasCapability(member: Pick<MemberRecord, "capabilities">, capability: Capability): boolean {
  return member.capabilities.includes(capability);
}

export function requireCapability(member: Pick<MemberRecord, "capabilities">, capability: Capability): void {
  if (!hasCapability(member, capability)) {
    throw new Error(`Missing capability: ${capability}`);
  }
}

export function validateExternalIdentity(identity: ExternalIdentity): boolean {
  return Boolean(identity.issuer.trim() && identity.subject.trim() && identity.email.trim() && identity.displayName.trim());
}
