import { Buffer } from "node:buffer";
import { createVerify } from "node:crypto";
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
  retentionManage: "retention:manage",
} as const;

export type Capability = (typeof capabilities)[keyof typeof capabilities];
export type Role = "owner" | "operator" | "viewer";

export const roleCapabilities: Readonly<Record<Role, readonly Capability[]>> = {
  owner: [capabilities.workspaceRead, capabilities.membershipManage, capabilities.timelineRead, capabilities.experimentWrite, capabilities.clusterConfigure, capabilities.logsRead, capabilities.correlationReview, capabilities.retentionManage],
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

export class LastWorkspaceOwnerError extends Error {
  constructor() {
    super("Cannot demote the last Workspace owner");
    this.name = "LastWorkspaceOwnerError";
  }
}

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
  readonly kind: "local" | "google" | "cloudflare";
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

export class CloudflareIdentityAdapter implements IdentityAdapter {
  readonly kind = "cloudflare" as const;
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
  if (environment.NODE_ENV === "preview") {
    if (!configuredCloudflareAccess(environment)) throw new Error("Preview identity requires complete Cloudflare Access JWT configuration");
    return new CloudflareIdentityAdapter();
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

export type CloudflareAccessConfig = Readonly<{
  issuer: string;
  audience: string;
  publicKey: string;
}>;

export type CloudflareAccessClaims = Readonly<{
  iss: string;
  aud: string | readonly string[];
  sub: string;
  email?: string;
  name?: string;
  exp: number;
}>;

export const CLOUDFLARE_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
const UNTRUSTED_IDENTITY_HEADERS = [
  "cf-access-authenticated-user-email",
  "x-authenticated-user-email",
  "x-user-email",
  "x-forwarded-email",
  "x-forwarded-user",
] as const;

export function validateCloudflareAccessClaims(
  claims: CloudflareAccessClaims,
  config: Pick<CloudflareAccessConfig, "issuer" | "audience">,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  return claims.iss === config.issuer
    && audiences.includes(config.audience)
    && claims.sub.trim().length > 0
    && Number.isSafeInteger(claims.exp)
    && claims.exp > nowSeconds;
}

function decodeJwtRecord(part: string): Record<string, unknown> | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof decoded === "object" && decoded !== null ? decoded as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function decodeCloudflareAccessClaims(token: string): CloudflareAccessClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = decodeJwtRecord(parts[0] ?? "");
  if (header?.alg !== "RS256") return null;
  const payload = decodeJwtRecord(parts[1] ?? "");
  if (!payload || typeof payload.iss !== "string" || typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
  const audience = payload.aud;
  if (typeof audience !== "string" && !(Array.isArray(audience) && audience.every((item) => typeof item === "string"))) return null;
  if (typeof payload.email !== "undefined" && typeof payload.email !== "string") return null;
  if (typeof payload.name !== "undefined" && typeof payload.name !== "string") return null;
  return {
    iss: payload.iss,
    aud: audience,
    sub: payload.sub,
    ...(payload.email === undefined ? {} : { email: payload.email }),
    ...(payload.name === undefined ? {} : { name: payload.name }),
    exp: payload.exp,
  };
}

function verifyCloudflareAccessSignature(token: string, publicKey: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || !publicKey.trim()) return false;
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();
    return verifier.verify(publicKey, Buffer.from(parts[2] ?? "", "base64url"));
  } catch {
    return false;
  }
}

export function configuredCloudflareAccess(environment: Record<string, string | undefined>): CloudflareAccessConfig | null {
  const issuer = environment.CLOUDFLARE_ACCESS_JWT_ISSUER?.trim();
  const audience = environment.CLOUDFLARE_ACCESS_JWT_AUDIENCE?.trim();
  const publicKey = environment.CLOUDFLARE_ACCESS_JWT_PUBLIC_KEY?.trim();
  if (!issuer && !audience && !publicKey) return null;
  if (!issuer || !audience || !publicKey) {
    throw new Error("Cloudflare Access requires CLOUDFLARE_ACCESS_JWT_ISSUER, CLOUDFLARE_ACCESS_JWT_AUDIENCE, and CLOUDFLARE_ACCESS_JWT_PUBLIC_KEY");
  }
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error("CLOUDFLARE_ACCESS_JWT_ISSUER must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:") throw new Error("CLOUDFLARE_ACCESS_JWT_ISSUER must be an absolute HTTPS URL");
  return { issuer, audience, publicKey };
}

export function cloudflareAccessIdentity(
  headers: Headers,
  config: CloudflareAccessConfig,
  nowSeconds = Math.floor(Date.now() / 1000),
): ExternalIdentity | null {
  if (UNTRUSTED_IDENTITY_HEADERS.some((header) => headers.has(header))) return null;
  const token = headers.get(CLOUDFLARE_ACCESS_JWT_HEADER);
  if (!token || !verifyCloudflareAccessSignature(token, config.publicKey)) return null;
  const claims = decodeCloudflareAccessClaims(token);
  if (!claims || !validateCloudflareAccessClaims(claims, config, nowSeconds)) return null;
  const email = claims.email?.trim() || `${claims.sub}@cloudflare-access.invalid`;
  return { issuer: claims.iss, subject: claims.sub, email, displayName: claims.name?.trim() || email };
}
