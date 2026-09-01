import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import type { Pool, PoolClient } from "pg";
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
  type LogAccessAuditMetadata,
  type LogAuditStore,
  type MemberRecord,
  type MembershipActor,
  type MembershipStore,
  type Role,
  validateExternalIdentity,
} from "../../identity/src/index.js";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  compareResourceVersions,
  MemoryClusterScopeStore,
  type AttentionReasonCode,
  type ClusterScope,
  type ClusterScopeStore,
  type NormalizedObservation,
  type NormalizedPodObservation,
  type SupportedResourceKind,
  SUPPORTED_RESOURCE_KINDS,
  markRecovery,
} from "../../cluster/src/index.js";
import {
  createExperimentRecord,
  ExperimentValidationError,
  updateExperimentRecord,
  suggestCorrelationCandidates,
  type ConfirmedLinkRecord,
  type CorrelationDecision,
  type CorrelationDecisionResult,
  type CorrelationEntry,
  type CorrelationSignal,
  type CorrelationSuggestionRecord,
  type ExperimentRecord,
  type ExperimentState,
  type ExperimentWorkload,
} from "../../domain/src/index.js";

export type DatabaseStatus = "ready" | "not-ready";

export interface DatabaseBoundary {
  readonly kind: "postgres" | "memory";
  readonly admission?: AdmissionStore;
  readonly clusterScope?: ClusterScopeStore;
  readonly timeline?: TimelineStore;
  readonly experiments?: ExperimentStore;
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const FOUNDATION_MIGRATION_ID = "0001_foundation";
export const ADMISSION_MIGRATION_ID = "0002_workspace_admission";
export const BETTER_AUTH_MIGRATION_ID = "0003_better_auth";
export const MEMBERSHIP_MIGRATION_ID = "0004_membership_management";
export const CLUSTER_SCOPE_MIGRATION_ID = "0005_cluster_scope";
export const OBSERVATION_TIMELINE_MIGRATION_ID = "0006_observation_timeline";
export const RECENT_LOGS_MIGRATION_ID = "0007_recent_logs";
export const NORMALIZED_OBSERVATION_MIGRATION_ID = "0008_normalized_observations";
export const OBSERVATION_CHECKPOINTS_MIGRATION_ID = "0009_observation_checkpoints";
export const TIMELINE_ATTENTION_MIGRATION_ID = "0010_timeline_attention";
export const STRUCTURED_EXPERIMENTS_MIGRATION_ID = "0011_structured_experiments";
export const CORRELATION_LINKS_MIGRATION_ID = "0012_correlation_links";
export const LIVE_TIMELINE_MIGRATION_ID = "0013_live_timeline";

type Migration = Readonly<{ id: string; path: string }>;

const migrations: readonly Migration[] = [
  { id: FOUNDATION_MIGRATION_ID, path: "../migrations/0001_foundation.sql" },
  { id: ADMISSION_MIGRATION_ID, path: "../migrations/0002_workspace_admission.sql" },
  { id: BETTER_AUTH_MIGRATION_ID, path: "../migrations/0003_better_auth.sql" },
  { id: MEMBERSHIP_MIGRATION_ID, path: "../migrations/0004_membership_management.sql" },
  { id: CLUSTER_SCOPE_MIGRATION_ID, path: "../migrations/0005_cluster_scope.sql" },
  { id: OBSERVATION_TIMELINE_MIGRATION_ID, path: "../migrations/0006_observation_timeline.sql" },
  { id: RECENT_LOGS_MIGRATION_ID, path: "../migrations/0007_recent_logs.sql" },
  { id: NORMALIZED_OBSERVATION_MIGRATION_ID, path: "../migrations/0008_normalized_observations.sql" },
  { id: OBSERVATION_CHECKPOINTS_MIGRATION_ID, path: "../migrations/0009_observation_checkpoints.sql" },
  { id: TIMELINE_ATTENTION_MIGRATION_ID, path: "../migrations/0010_timeline_attention.sql" },
  { id: STRUCTURED_EXPERIMENTS_MIGRATION_ID, path: "../migrations/0011_structured_experiments.sql" },
  { id: CORRELATION_LINKS_MIGRATION_ID, path: "../migrations/0012_correlation_links.sql" },
  { id: LIVE_TIMELINE_MIGRATION_ID, path: "../migrations/0013_live_timeline.sql" },
];

function sessionForMember(member: MemberRecord, authSession?: AuthSession): AuthenticatedSession {
  return {
    token: authSession?.token ?? randomUUID(),
    expiresAt: authSession?.expiresAt ?? new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    member,
  };
}

export class MemoryAdmissionStore implements AdmissionStore, MembershipStore, LogAuditStore {
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

  async recordLogAccess(actor: Pick<MemberRecord, "id">, metadata: LogAccessAuditMetadata): Promise<void> {
    this.audit("log.accessed", "log_window", randomUUID(), actor.id, {
      clusterId: metadata.clusterId,
      namespace: metadata.namespace,
      pod: metadata.pod,
      container: metadata.container,
      tail: metadata.tail,
      lineCount: metadata.lineCount,
      byteCount: metadata.byteCount,
    });
  }

  async listAuditRecords(): Promise<readonly AuditRecord[]> {
    return Object.freeze(this.audits.map((audit) => ({ ...audit, metadata: { ...audit.metadata } })));
  }

  memberCount(): number {
    return this.identities.size;
  }
}

type PoolProvider = () => Promise<Pool>;
type ClusterRow = Readonly<{
  id: string;
  workspace_id: string;
  name: string;
  endpoint: string;
  approved_namespaces: string[];
  approved_resource_kinds: string[];
}>;

export type TimelineQuery = Readonly<{
  limit: number;
  cursor?: string;
  kind?: SupportedResourceKind;
  namespace?: string;
  name?: string;
  state?: string;
  attention?: boolean;
  unread?: boolean;
}>;

export type ObservationTimelineEntry = Readonly<{
  id: string;
  workspaceId: string;
  clusterId: string;
  entryType: "observation";
  occurredAt: string;
  attentionItem: boolean;
  attentionReason: AttentionReasonCode | null;
  recoveryOf: string | null;
  observation: NormalizedObservation;
  attention: boolean;
  attentionUnread: boolean;
  confirmedLinks?: readonly ConfirmedLinkRecord[];
}>;

export type ExperimentTimelineEntry = Readonly<{
  id: string;
  workspaceId: string;
  clusterId: string | null;
  entryType: "experiment";
  occurredAt: string;
  experiment: ExperimentRecord;
  confirmedLinks?: readonly ConfirmedLinkRecord[];
}>;

export type TimelineEntry = ObservationTimelineEntry | ExperimentTimelineEntry;

export type ObservationPersistenceResult = Readonly<{
  observation: NormalizedObservation;
  entry: TimelineEntry;
  duplicate: boolean;
}>;

export type IngestionCheckpoint = Readonly<{
  workspaceId: string;
  clusterId: string;
  namespace: string;
  resourceKind: string;
  resourceVersion: string;
  updatedAt: string;
}>;

export type TimelinePage = Readonly<{
  entries: readonly TimelineEntry[];
  nextCursor: string | null;
  resumeCursor?: string;
  unreadAttentionCount?: number;
}>;

export class CorrelationDecisionConflictError extends Error {
  constructor(readonly status: "confirmed" | "rejected") {
    super(`Correlation Suggestion is already ${status}`);
    this.name = "CorrelationDecisionConflictError";
  }
}

export interface CorrelationStore {
  listCorrelationSuggestions(workspaceId: string): Promise<readonly CorrelationSuggestionRecord[]>;
  getCorrelationSuggestion(workspaceId: string, id: string): Promise<CorrelationSuggestionRecord | null>;
  decideCorrelationSuggestion(workspaceId: string, id: string, memberId: string, decision: CorrelationDecision): Promise<CorrelationDecisionResult | null>;
  listConfirmedLinks(workspaceId: string, entryId?: string): Promise<readonly ConfirmedLinkRecord[]>;
}

export type TimelineNotification = Readonly<{
  entryId: string;
}>;

export type TimelineNotificationListener = (notification: TimelineNotification) => void;
export type TimelineNotificationErrorListener = (error: unknown) => void;

export interface TimelineNotificationSource {
  subscribeTimeline(listener: TimelineNotificationListener): Promise<() => void>;
  onTimelineError?(listener: TimelineNotificationErrorListener): () => void;
  timelineNotificationsHealthy?(): boolean;
}

export function parseTimelineNotification(payload: string): TimelineNotification | null {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || typeof record.entryId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.entryId)) return null;
    return { entryId: record.entryId };
  } catch {
    return null;
  }
}
export type AttentionReviewResult = Readonly<{
  entryId: string;
  reviewed: boolean;
  unreadCount: number;
}>;

export class TimelineQueryValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super("Invalid Timeline query");
    this.name = "TimelineQueryValidationError";
  }
}

const timelineFilterFields = ["kind", "namespace", "name", "state", "attention", "unread", "memberId"] as const;
const timelineStates = ["Pending", "Running", "Succeeded", "Failed", "Unknown"] as const;
type TimelineFilterField = (typeof timelineFilterFields)[number];

type TimelineCursor = Readonly<{
  version: 2;
  sequence: string;
  memberId: string | null;
  filters: string;
}>;

export const DEFAULT_TIMELINE_CURSOR_SECRET = "tracegarden-test-timeline-cursor-secret";

function timelineFilters(query: TimelineQuery, memberId?: string): Readonly<Record<TimelineFilterField, string | boolean | null | undefined>> {
  return {
    kind: query.kind,
    namespace: query.namespace,
    name: query.name,
    state: query.state,
    attention: query.attention,
    unread: query.unread,
    memberId: memberId ?? null,
  };
}

function timelineFilterKey(query: TimelineQuery, memberId?: string): string {
  return JSON.stringify(timelineFilters(query, memberId));
}

function base64UrlEncode(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(normalized);
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64UrlEncode(decoded) !== value) throw new Error("base64url encoding is not canonical");
  return decoded;
}

type StoredTimelineEntry = TimelineEntry & Readonly<{ timelineSequence: string }>;

function encodeTimelineCursor(entry: StoredTimelineEntry, query: TimelineQuery, secret: string, memberId?: string): string {
  const payload: TimelineCursor = { version: 2, sequence: entry.timelineSequence, memberId: memberId ?? null, filters: timelineFilterKey(query, memberId) };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(createHmac("sha256", secret).update(encodedPayload).digest());
  return `${encodedPayload}.${signature}`;
}

function validTimelineCursorShape(value: string): boolean {
  return value.length <= 2048 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function decodeTimelineCursor(value: string, query: TimelineQuery, secret: string, memberId?: string): Readonly<{ sequence: string }> {
  try {
    if (!validTimelineCursorShape(value)) throw new Error("cursor encoding is invalid");
    const separator = value.indexOf(".");
    const encodedPayload = value.slice(0, separator);
    const encodedSignature = value.slice(separator + 1);
    const expectedSignature = createHmac("sha256", secret).update(encodedPayload).digest();
    const actualSignature = base64UrlDecode(encodedSignature);
    if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
      throw new Error("cursor signature is invalid");
    }
    const decoded: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload)));
    if (typeof decoded !== "object" || decoded === null) throw new Error("cursor object required");
    const record = decoded as Record<string, unknown>;
    if (record.version !== 2 || typeof record.sequence !== "string" || !/^[1-9]\d*$/.test(record.sequence) || typeof record.filters !== "string" || (typeof record.memberId !== "string" && record.memberId !== null) || (typeof record.memberId === "string" && !record.memberId.trim())) {
      throw new Error("cursor fields are invalid");
    }
    if (record.memberId !== (memberId ?? null) || record.filters !== timelineFilterKey(query, memberId)) throw new Error("cursor does not match query filters");
    return { sequence: record.sequence };
  } catch {
    throw new TimelineQueryValidationError(["cursor must be an opaque valid Timeline cursor for these filters"]);
  }
}

function optionalTimelineFilter(value: unknown, field: string, issues: string[], maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push(`${field} must be a string`);
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) issues.push(`${field} must be at most ${maxLength} characters`);
  return normalized;
}

function optionalTimelineBoolean(value: unknown, field: string, issues: string[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === false) return value;
  if (value === "true" || value === "false") return value === "true";
  issues.push(`${field} must be true or false`);
  return undefined;
}

export function parseTimelineQuery(input: unknown): TimelineQuery {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TimelineQueryValidationError(["query must be an object"]);
  }
  const record = input as Record<string, unknown>;
  const rawLimit = record.limit === undefined ? "50" : record.limit;
  const limit = typeof rawLimit === "number"
    ? rawLimit
    : typeof rawLimit === "string" && /^\d+$/.test(rawLimit.trim())
      ? Number(rawLimit)
      : Number.NaN;
  const issues: string[] = [];
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) issues.push("limit must be an integer from 1 to 100");
  const rawCursor = record.cursor;
  if (rawCursor !== undefined && (typeof rawCursor !== "string" || !rawCursor.trim())) issues.push("cursor must be a non-empty string");
  const rawKind = record.kind;
  const kind = rawKind === undefined ? undefined : typeof rawKind === "string" && (SUPPORTED_RESOURCE_KINDS as readonly string[]).includes(rawKind) ? rawKind as SupportedResourceKind : undefined;
  if (rawKind !== undefined && kind === undefined) issues.push(`kind must be one of ${SUPPORTED_RESOURCE_KINDS.join(", ")}`);
  const namespace = optionalTimelineFilter(record.namespace, "namespace", issues, 63);
  const name = optionalTimelineFilter(record.name, "name", issues, 253);
  const rawState = record.state === undefined ? record.phase : record.state;
  const state = optionalTimelineFilter(rawState, "state", issues, 50);
  if (state && !(timelineStates as readonly string[]).includes(state)) issues.push("state must be a supported Pod phase");
  const attention = optionalTimelineBoolean(record.attention, "attention", issues);
  const unread = optionalTimelineBoolean(record.unread, "unread", issues);
  if (unread === true && attention === false) issues.push("unread cannot be used with attention=false");
  if (issues.length > 0) throw new TimelineQueryValidationError(issues);
  const query: TimelineQuery = {
    limit,
    ...(typeof rawCursor === "string" && rawCursor.trim() ? { cursor: rawCursor.trim() } : {}),
    ...(kind ? { kind } : {}),
    ...(namespace ? { namespace } : {}),
    ...(name ? { name } : {}),
    ...(state ? { state } : {}),
    ...(attention === undefined ? {} : { attention }),
    ...(unread === undefined ? {} : { unread }),
  };
  if (query.cursor && !validTimelineCursorShape(query.cursor)) {
    throw new TimelineQueryValidationError(["cursor must be an opaque valid Timeline cursor for these filters"]);
  }
  return query;
}

export interface ExperimentStore {
  createExperiment(workspaceId: string, createdByMemberId: string, input: unknown): Promise<ExperimentRecord>;
  updateExperiment(workspaceId: string, id: string, input: unknown): Promise<ExperimentRecord | null>;
  getExperiment(workspaceId: string, id: string): Promise<ExperimentRecord | null>;
  listExperiments(workspaceId: string): Promise<readonly ExperimentRecord[]>;
}

export interface TimelineStore {
  recordObservation(observation: NormalizedObservation): Promise<ObservationPersistenceResult>;
  recordObservations?(observations: readonly NormalizedObservation[]): Promise<readonly ObservationPersistenceResult[]>;
  getIngestionCheckpoint?(workspaceId: string, clusterId: string, resourceKind: string, namespace: string): Promise<IngestionCheckpoint | null>;
  recordObservationsAndCheckpoint?(
    observations: readonly NormalizedObservation[],
    checkpoint: IngestionCheckpointInput,
  ): Promise<readonly ObservationPersistenceResult[]>;
  advanceIngestionCheckpoint?(checkpoint: IngestionCheckpointInput): Promise<IngestionCheckpoint | null>;
  clearIngestionCheckpoint?(checkpoint: Omit<IngestionCheckpointInput, "resourceVersion">): Promise<void>;
  listTimelineEntries(workspaceId: string, query: TimelineQuery, memberId?: string): Promise<TimelinePage>;
  countTimelineEntriesAfterCursor?(workspaceId: string, query: TimelineQuery, memberId?: string): Promise<number>;
  getTimelineEntry(workspaceId: string, id: string): Promise<TimelineEntry | null>;
  countObservations(workspaceId: string): Promise<number>;
  countTimelineEntries(workspaceId: string): Promise<number>;
  unreadAttentionCount?(workspaceId: string, memberId: string): Promise<number>;
  reviewAttentionItem?(workspaceId: string, memberId: string, entryId: string): Promise<AttentionReviewResult | null>;
  listCorrelationSuggestions?(workspaceId: string): Promise<readonly CorrelationSuggestionRecord[]>;
  getCorrelationSuggestion?(workspaceId: string, id: string): Promise<CorrelationSuggestionRecord | null>;
  decideCorrelationSuggestion?(workspaceId: string, id: string, memberId: string, decision: CorrelationDecision): Promise<CorrelationDecisionResult | null>;
  listConfirmedLinks?(workspaceId: string, entryId?: string): Promise<readonly ConfirmedLinkRecord[]>;
}

export function isAttentionObservation(observation: Pick<NormalizedObservation, "attention">): boolean {
  return observation.attention;
}

export type IngestionCheckpointInput = Readonly<{
  workspaceId: string;
  clusterId: string;
  namespace: string;
  resourceKind: string;
  resourceVersion: string;
}>;

export type ObservationStore = TimelineStore;

function observationKey(observation: NormalizedObservation): string {
  return `${observation.workspaceId}\u0000${observation.clusterId}\u0000${observation.sourceKey}`;
}

function checkpointKey(checkpoint: Pick<IngestionCheckpointInput, "workspaceId" | "clusterId" | "namespace" | "resourceKind">): string {
  return `${checkpoint.workspaceId}\u0000${checkpoint.clusterId}\u0000${checkpoint.namespace}\u0000${checkpoint.resourceKind}`;
}

function checkpointVersionShouldReplace(candidate: string, previous: string): boolean {
  if (candidate === previous) return false;
  const candidateIsDecimal = /^\d+$/.test(candidate);
  const previousIsDecimal = /^\d+$/.test(previous);
  return candidateIsDecimal && previousIsDecimal ? compareResourceVersions(candidate, previous) > 0 : true;
}

function checkpointRecord(checkpoint: IngestionCheckpointInput): IngestionCheckpoint {
  return {
    ...checkpoint,
    updatedAt: new Date().toISOString(),
  };
}

function cloneObservation(observation: NormalizedObservation): NormalizedObservation {
  return {
    ...observation,
    ownerReferences: [...observation.ownerReferences],
    labels: { ...observation.labels },
  };
}

function cloneExperiment(experiment: ExperimentRecord): ExperimentRecord {
  return {
    ...experiment,
    tags: [...experiment.tags],
    workloads: experiment.workloads.map((workload) => ({ ...workload })),
    ...(experiment.confirmedLinks ? { confirmedLinks: experiment.confirmedLinks.map((link) => ({ ...link })) } : {}),
  };
}

function cloneEntry(entry: TimelineEntry): TimelineEntry {
  return entry.entryType === "observation"
    ? { ...entry, observation: cloneObservation(entry.observation), ...(entry.confirmedLinks ? { confirmedLinks: entry.confirmedLinks.map((link) => ({ ...link })) } : {}) }
    : { ...entry, experiment: cloneExperiment(entry.experiment), ...(entry.confirmedLinks ? { confirmedLinks: entry.confirmedLinks.map((link) => ({ ...link })) } : {}) };
}

function correlationEntryFor(entry: TimelineEntry): CorrelationEntry {
  return entry.entryType === "observation"
    ? {
      id: entry.id,
      workspaceId: entry.workspaceId,
      occurredAt: entry.occurredAt,
      clusterId: entry.clusterId,
      observation: entry.observation,
    }
    : {
      id: entry.id,
      workspaceId: entry.workspaceId,
      occurredAt: entry.occurredAt,
      clusterId: entry.clusterId,
      experiment: entry.experiment,
    };
}

function timelineEntryFor(observation: NormalizedObservation, timelineSequence: bigint): StoredTimelineEntry {
  return {
    id: randomUUID(),
    timelineSequence: timelineSequence.toString(),
    workspaceId: observation.workspaceId,
    clusterId: observation.clusterId,
    entryType: "observation",
    occurredAt: observation.observedAt,
    attentionItem: observation.attention,
    attentionReason: observation.attentionReason,
    recoveryOf: observation.recoveryOf,
    observation,
    attention: observation.attention,
    attentionUnread: false,
  };
}

function entryMatchesQuery(entry: TimelineEntry, query: TimelineQuery): boolean {
  if (entry.entryType === "experiment") {
    return query.kind === undefined && query.namespace === undefined && query.name === undefined && query.state === undefined
      && query.attention !== true && query.unread !== true;
  }
  const observation = entry.observation;
  const state = observation.kind === "Pod" ? observation.phase : null;
  return (query.kind === undefined || observation.kind === query.kind)
    && (query.namespace === undefined || observation.namespace === query.namespace)
    && (query.name === undefined || observation.name === query.name)
    && (query.state === undefined || state === query.state)
    && (query.attention === undefined || entry.attentionItem === query.attention)
    && (query.unread === undefined || (query.unread ? entry.attentionItem && entry.attentionUnread : !entry.attentionUnread));
}

function compareTimelineSequences(left: string, right: string): number {
  const leftSequence = BigInt(left);
  const rightSequence = BigInt(right);
  return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
}

function pageFromEntries(entries: readonly StoredTimelineEntry[], query: TimelineQuery, cursorSecret: string, memberId?: string): TimelinePage {
  const sorted = entries.filter((entry) => entryMatchesQuery(entry, query)).sort((left, right) => compareTimelineSequences(left.timelineSequence, right.timelineSequence));
  const cursor = query.cursor ? decodeTimelineCursor(query.cursor, query, cursorSecret, memberId) : null;
  const afterCursor = cursor ? sorted.filter((entry) => compareTimelineSequences(entry.timelineSequence, cursor.sequence) > 0) : sorted;
  const page = afterCursor.slice(0, query.limit);
  return {
    entries: page.map(cloneEntry),
    nextCursor: afterCursor.length > query.limit && page.length > 0 ? encodeTimelineCursor(page[page.length - 1] as StoredTimelineEntry, query, cursorSecret, memberId) : null,
    ...(memberId !== undefined && page.length > 0 ? { resumeCursor: encodeTimelineCursor(page[page.length - 1] as StoredTimelineEntry, query, cursorSecret, memberId) } : {}),
  };
}

export class MemoryObservationStore implements TimelineStore, TimelineNotificationSource {
  private readonly observations = new Map<string, NormalizedObservation>();
  private readonly experiments = new Map<string, ExperimentRecord>();
  private readonly entries = new Map<string, StoredTimelineEntry>();
  private nextTimelineSequence = 0n;
  private readonly ingestionOrders = new Map<string, bigint>();
  private nextIngestionOrder = 0n;
  private readonly checkpoints = new Map<string, IngestionCheckpoint>();
  private readonly attentionReviews = new Set<string>();
  private readonly correlationSuggestions = new Map<string, CorrelationSuggestionRecord>();
  private readonly confirmedLinks = new Map<string, ConfirmedLinkRecord>();
  private readonly timelineListeners = new Set<TimelineNotificationListener>();

  private readonly cursorSecret: string;
  private readonly clusterScopeStore: ClusterScopeStore | undefined;

  constructor(cursorSecretOrClusterScopeStore: string | ClusterScopeStore = DEFAULT_TIMELINE_CURSOR_SECRET, clusterScopeStore?: ClusterScopeStore) {
    if (typeof cursorSecretOrClusterScopeStore === "string") {
      if (!cursorSecretOrClusterScopeStore.trim()) throw new Error("Timeline cursor secret is required");
      this.cursorSecret = cursorSecretOrClusterScopeStore;
      this.clusterScopeStore = clusterScopeStore;
    } else {
      this.cursorSecret = DEFAULT_TIMELINE_CURSOR_SECRET;
      this.clusterScopeStore = cursorSecretOrClusterScopeStore;
    }
  }

  private async validateExperimentClusters(workspaceId: string, workloads: readonly ExperimentWorkload[]): Promise<void> {
    if (workloads.length === 0 || !this.clusterScopeStore) return;
    const scope = await this.clusterScopeStore.get(workspaceId);
    if (!scope || workloads.some((workload) => workload.clusterId !== scope.clusterId)) {
      throw new ExperimentValidationError([{
        field: "workloads",
        message: "must reference the Cluster configured for the Workspace",
      }]);
    }
  }

  private async validateConfiguredCluster(workspaceId: string, clusterId: string, recordName: string): Promise<void> {
    if (!this.clusterScopeStore) return;
    const scope = await this.clusterScopeStore.get(workspaceId);
    if (!scope || scope.clusterId !== clusterId) {
      throw new Error(`${recordName} Cluster does not belong to its Workspace`);
    }
  }

  private async validateObservationOwnership(observations: readonly NormalizedObservation[]): Promise<void> {
    for (const observation of observations) {
      await this.validateConfiguredCluster(observation.workspaceId, observation.clusterId, "Observation");
    }
  }

  async recordObservation(observation: NormalizedObservation): Promise<ObservationPersistenceResult> {
    const results = await this.recordObservations([observation]);
    const result = results[0];
    if (!result) throw new Error("Observation persistence returned no row");
    return result;
  }

  private recordObservationsInternal(
    observations: readonly NormalizedObservation[],
    checkpoint?: IngestionCheckpointInput,
  ): readonly ObservationPersistenceResult[] {
    const pendingObservations = new Map(this.observations);
    const pendingEntries = new Map(this.entries);
    const pendingOrders = new Map(this.ingestionOrders);
    const pendingCheckpoints = new Map(this.checkpoints);
    const results: ObservationPersistenceResult[] = [];
    const createdEntryIds: string[] = [];
    for (const observation of observations) {
      const key = observationKey(observation);
      const existing = pendingObservations.get(key);
      if (existing) {
        const entry = [...pendingEntries.values()].find((candidate) => candidate.entryType === "observation"
          && candidate.observation.sourceKey === observation.sourceKey
          && candidate.workspaceId === observation.workspaceId
          && candidate.clusterId === observation.clusterId);
        if (!entry) throw new Error("Timeline entry is missing for an existing Observation");
        results.push({ observation: cloneObservation(existing), entry: cloneEntry(entry), duplicate: true });
        continue;
      }
      const previous = [...pendingObservations.entries()]
        .filter(([, candidate]) => candidate.workspaceId === observation.workspaceId && candidate.clusterId === observation.clusterId && candidate.sourceIdentity === observation.sourceIdentity)
        .sort(([leftKey], [rightKey]) => {
          const leftOrder = pendingOrders.get(leftKey) ?? 0n;
          const rightOrder = pendingOrders.get(rightKey) ?? 0n;
          return leftOrder < rightOrder ? 1 : leftOrder > rightOrder ? -1 : 0;
        })[0]?.[1] ?? null;
      const storedObservation = cloneObservation(markRecovery(observation, previous));
      const entry = timelineEntryFor(storedObservation, ++this.nextTimelineSequence);
      pendingObservations.set(key, storedObservation);
      pendingEntries.set(entry.id, entry);
      pendingOrders.set(key, ++this.nextIngestionOrder);
      createdEntryIds.push(entry.id);
      results.push({ observation: cloneObservation(storedObservation), entry: cloneEntry(entry), duplicate: false });
    }
    if (checkpoint) {
      const key = checkpointKey(checkpoint);
      const previous = pendingCheckpoints.get(key);
      if (!previous || checkpointVersionShouldReplace(checkpoint.resourceVersion, previous.resourceVersion)) {
        pendingCheckpoints.set(key, checkpointRecord(checkpoint));
      }
    }
    this.observations.clear();
    for (const [key, observation] of pendingObservations) this.observations.set(key, observation);
    this.entries.clear();
    for (const [id, entry] of pendingEntries) this.entries.set(id, entry);
    this.ingestionOrders.clear();
    for (const [key, order] of pendingOrders) this.ingestionOrders.set(key, order);
    this.checkpoints.clear();
    for (const [key, value] of pendingCheckpoints) this.checkpoints.set(key, value);
    for (const entryId of createdEntryIds) {
      for (const listener of this.timelineListeners) {
        try { listener({ entryId }); } catch { /* notification listeners cannot affect persistence */ }
      }
    }
    return results;
  }

  async subscribeTimeline(listener: TimelineNotificationListener): Promise<() => void> {
    this.timelineListeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.timelineListeners.delete(listener);
    };
  }

  timelineNotificationsHealthy(): boolean {
    return true;
  }

  async recordObservations(observations: readonly NormalizedObservation[]): Promise<readonly ObservationPersistenceResult[]> {
    await this.validateObservationOwnership(observations);
    const results = this.recordObservationsInternal(observations);
    for (const workspaceId of new Set(observations.map((observation) => observation.workspaceId))) await this.refreshCorrelationSuggestions(workspaceId);
    return results;
  }

  async recordObservationsAndCheckpoint(
    observations: readonly NormalizedObservation[],
    checkpoint: IngestionCheckpointInput,
  ): Promise<readonly ObservationPersistenceResult[]> {
    await this.validateObservationOwnership(observations);
    await this.validateConfiguredCluster(checkpoint.workspaceId, checkpoint.clusterId, "Ingestion Checkpoint");
    const results = this.recordObservationsInternal(observations, checkpoint);
    for (const workspaceId of new Set(observations.map((observation) => observation.workspaceId))) await this.refreshCorrelationSuggestions(workspaceId);
    return results;
  }

  async getIngestionCheckpoint(workspaceId: string, clusterId: string, resourceKind: string, namespace: string): Promise<IngestionCheckpoint | null> {
    const checkpoint = this.checkpoints.get(checkpointKey({ workspaceId, clusterId, namespace, resourceKind }));
    return checkpoint ? { ...checkpoint } : null;
  }

  async advanceIngestionCheckpoint(checkpoint: IngestionCheckpointInput): Promise<IngestionCheckpoint | null> {
    await this.validateConfiguredCluster(checkpoint.workspaceId, checkpoint.clusterId, "Ingestion Checkpoint");
    const key = checkpointKey(checkpoint);
    const previous = this.checkpoints.get(key);
    if (!previous || checkpointVersionShouldReplace(checkpoint.resourceVersion, previous.resourceVersion)) {
      this.checkpoints.set(key, checkpointRecord(checkpoint));
    }
    const current = this.checkpoints.get(key);
    return current ? { ...current } : null;
  }

  async clearIngestionCheckpoint(checkpoint: Omit<IngestionCheckpointInput, "resourceVersion">): Promise<void> {
    await this.validateConfiguredCluster(checkpoint.workspaceId, checkpoint.clusterId, "Ingestion Checkpoint");
    this.checkpoints.delete(checkpointKey(checkpoint));
  }

  async createExperiment(workspaceId: string, createdByMemberId: string, input: unknown): Promise<ExperimentRecord> {
    const timelineEntryId = randomUUID();
    const experiment = createExperimentRecord(workspaceId, createdByMemberId, timelineEntryId, input);
    await this.validateExperimentClusters(workspaceId, experiment.workloads);
    const entry: StoredTimelineEntry = {
      id: timelineEntryId,
      timelineSequence: (++this.nextTimelineSequence).toString(),
      workspaceId,
      clusterId: experiment.workloads[0]?.clusterId ?? null,
      entryType: "experiment",
      occurredAt: experiment.createdAt,
      experiment,
    };
    this.experiments.set(experiment.id, experiment);
    this.entries.set(entry.id, entry);
    await this.refreshCorrelationSuggestions(workspaceId);
    for (const listener of this.timelineListeners) {
      try { listener({ entryId: entry.id }); } catch { /* notification listeners cannot affect persistence */ }
    }
    return cloneExperiment(experiment);
  }

  async updateExperiment(workspaceId: string, id: string, input: unknown): Promise<ExperimentRecord | null> {
    const current = this.experiments.get(id);
    if (!current || current.workspaceId !== workspaceId) return null;
    const updated = updateExperimentRecord(current, input);
    await this.validateExperimentClusters(workspaceId, updated.workloads);
    const entry = this.entries.get(current.timelineEntryId);
    if (!entry || entry.entryType !== "experiment") throw new Error("Timeline entry is missing for an Experiment");
    const replacement: StoredTimelineEntry = { ...entry, clusterId: updated.workloads[0]?.clusterId ?? null, experiment: updated };
    this.experiments.set(id, updated);
    this.entries.set(updated.timelineEntryId, replacement);
    await this.refreshCorrelationSuggestions(workspaceId);
    return cloneExperiment(updated);
  }

  async getExperiment(workspaceId: string, id: string): Promise<ExperimentRecord | null> {
    await this.refreshCorrelationSuggestions(workspaceId);
    const experiment = this.experiments.get(id);
    if (!experiment || experiment.workspaceId !== workspaceId) return null;
    const links = [...this.confirmedLinks.values()].filter((link) => link.leftEntryId === experiment.timelineEntryId || link.rightEntryId === experiment.timelineEntryId);
    return cloneExperiment(links.length > 0 ? { ...experiment, confirmedLinks: links } : experiment);
  }

  async listExperiments(workspaceId: string): Promise<readonly ExperimentRecord[]> {
    await this.refreshCorrelationSuggestions(workspaceId);
    return Object.freeze([...this.experiments.values()]
      .filter((experiment) => experiment.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((experiment) => {
        const links = [...this.confirmedLinks.values()].filter((link) => link.leftEntryId === experiment.timelineEntryId || link.rightEntryId === experiment.timelineEntryId);
        return cloneExperiment(links.length > 0 ? { ...experiment, confirmedLinks: links } : experiment);
      }));
  }

  private async refreshCorrelationSuggestions(workspaceId: string): Promise<void> {
    const entries = [...this.entries.values()].filter((entry) => entry.workspaceId === workspaceId);
    for (const candidate of suggestCorrelationCandidates(entries.map(correlationEntryFor))) {
      const key = `${candidate.workspaceId}\u0000${candidate.leftEntryId}\u0000${candidate.rightEntryId}`;
      const existing = this.correlationSuggestions.get(key);
      this.correlationSuggestions.set(key, existing
        ? { ...existing, signals: [...candidate.signals] }
        : candidate);
    }
  }

  async listCorrelationSuggestions(workspaceId: string): Promise<readonly CorrelationSuggestionRecord[]> {
    await this.refreshCorrelationSuggestions(workspaceId);
    return Object.freeze([...this.correlationSuggestions.values()]
      .filter((suggestion) => suggestion.workspaceId === workspaceId && suggestion.status === "pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((suggestion) => ({ ...suggestion, signals: [...suggestion.signals] })));
  }

  async getCorrelationSuggestion(workspaceId: string, id: string): Promise<CorrelationSuggestionRecord | null> {
    await this.refreshCorrelationSuggestions(workspaceId);
    const suggestion = [...this.correlationSuggestions.values()].find((candidate) => candidate.workspaceId === workspaceId && candidate.id === id);
    if (!suggestion) return null;
    const link = [...this.confirmedLinks.values()].find((candidate) => candidate.suggestionId === id);
    return { ...suggestion, signals: [...suggestion.signals], ...(link ? { confirmedLink: { ...link } } : {}) };
  }

  async decideCorrelationSuggestion(workspaceId: string, id: string, memberId: string, decision: CorrelationDecision): Promise<CorrelationDecisionResult | null> {
    if (!workspaceId.trim() || !id.trim() || !memberId.trim()) throw new Error("Correlation decision identifiers are required");
    await this.refreshCorrelationSuggestions(workspaceId);
    const suggestion = [...this.correlationSuggestions.values()].find((candidate) => candidate.workspaceId === workspaceId && candidate.id === id);
    if (!suggestion) return null;
    const existingLink = [...this.confirmedLinks.values()].find((candidate) => candidate.suggestionId === id) ?? null;
    if (suggestion.status !== "pending") {
      if ((decision === "confirm") !== (suggestion.status === "confirmed")) throw new CorrelationDecisionConflictError(suggestion.status);
      return { suggestion: { ...suggestion, signals: [...suggestion.signals], ...(existingLink ? { confirmedLink: { ...existingLink } } : {}) }, confirmedLink: existingLink, idempotent: true };
    }
    const now = new Date().toISOString();
    let confirmedLink: ConfirmedLinkRecord | null = null;
    if (decision === "confirm") {
      confirmedLink = { id: randomUUID(), workspaceId, suggestionId: id, leftEntryId: suggestion.leftEntryId, rightEntryId: suggestion.rightEntryId, confirmedByMemberId: memberId, confirmedAt: now };
      this.confirmedLinks.set(id, confirmedLink);
    }
    const decided: CorrelationSuggestionRecord = { ...suggestion, status: decision === "confirm" ? "confirmed" : "rejected", decidedAt: now, decidedByMemberId: memberId, ...(confirmedLink ? { confirmedLink } : {}) };
    this.correlationSuggestions.set(`${workspaceId}\u0000${suggestion.leftEntryId}\u0000${suggestion.rightEntryId}`, decided);
    return { suggestion: { ...decided, signals: [...decided.signals] }, confirmedLink, idempotent: false };
  }

  async listConfirmedLinks(workspaceId: string, entryId?: string): Promise<readonly ConfirmedLinkRecord[]> {
    return Object.freeze([...this.confirmedLinks.values()]
      .filter((link) => link.workspaceId === workspaceId && (entryId === undefined || link.leftEntryId === entryId || link.rightEntryId === entryId))
      .sort((left, right) => left.confirmedAt.localeCompare(right.confirmedAt) || left.id.localeCompare(right.id))
      .map((link) => ({ ...link })));
  }

  private entryWithLinks(entry: StoredTimelineEntry): StoredTimelineEntry {
    const links = [...this.confirmedLinks.values()].filter((link) => link.leftEntryId === entry.id || link.rightEntryId === entry.id);
    return links.length > 0 ? { ...entry, confirmedLinks: links } : entry;
  }

  async listTimelineEntries(workspaceId: string, query: TimelineQuery, memberId?: string): Promise<TimelinePage> {
    if (query.unread !== undefined && memberId === undefined) {
      throw new TimelineQueryValidationError(["member is required for unread Attention filtering"]);
    }
    const entries = [...this.entries.values()]
      .filter((entry) => entry.workspaceId === workspaceId)
      .map((entry): StoredTimelineEntry => this.entryWithLinks(entry.entryType === "observation"
        ? { ...entry, attentionUnread: memberId !== undefined && entry.attentionItem && !this.attentionReviews.has(`${entry.id}\u0000${memberId}`) }
        : entry));
    const page = pageFromEntries(entries, query, this.cursorSecret, memberId);
    return memberId ? { ...page, unreadAttentionCount: await this.unreadAttentionCount(workspaceId, memberId) } : page;
  }

  async countTimelineEntriesAfterCursor(workspaceId: string, query: TimelineQuery, memberId?: string): Promise<number> {
    const page = await this.listTimelineEntries(workspaceId, { ...query, limit: 100 }, memberId);
    let count = page.entries.length;
    let nextCursor = page.nextCursor;
    while (nextCursor) {
      const nextPage = await this.listTimelineEntries(workspaceId, { ...query, limit: 100, cursor: nextCursor }, memberId);
      count += nextPage.entries.length;
      nextCursor = nextPage.nextCursor;
    }
    return count;
  }

  async getTimelineEntry(workspaceId: string, id: string): Promise<TimelineEntry | null> {
    const entry = this.entries.get(id);
    return entry?.workspaceId === workspaceId ? cloneEntry(this.entryWithLinks(entry)) : null;
  }

  async unreadAttentionCount(workspaceId: string, memberId: string): Promise<number> {
    return [...this.entries.values()].filter((entry) => entry.entryType === "observation" && entry.workspaceId === workspaceId && entry.attentionItem && !this.attentionReviews.has(`${entry.id}\u0000${memberId}`)).length;
  }

  async reviewAttentionItem(workspaceId: string, memberId: string, entryId: string): Promise<AttentionReviewResult | null> {
    const entry = this.entries.get(entryId);
    if (!entry || entry.entryType !== "observation" || entry.workspaceId !== workspaceId || !entry.attentionItem) return null;
    const key = `${entryId}\u0000${memberId}`;
    const reviewed = !this.attentionReviews.has(key);
    this.attentionReviews.add(key);
    return { entryId, reviewed, unreadCount: await this.unreadAttentionCount(workspaceId, memberId) };
  }

  async countObservations(workspaceId: string): Promise<number> {
    return [...this.observations.values()].filter((observation) => observation.workspaceId === workspaceId).length;
  }

  async countTimelineEntries(workspaceId: string): Promise<number> {
    return [...this.entries.values()].filter((entry) => entry.workspaceId === workspaceId).length;
  }
}

export const MemoryTimelineStore = MemoryObservationStore;

export async function recordPodObservation(store: TimelineStore, observation: NormalizedPodObservation): Promise<ObservationPersistenceResult> {
  return store.recordObservation(observation);
}

export async function recordObservation(store: TimelineStore, observation: NormalizedObservation): Promise<ObservationPersistenceResult> {
  return store.recordObservation(observation);
}

function clusterFromRow(row: ClusterRow): ClusterScope {
  return {
    workspaceId: row.workspace_id,
    clusterId: row.id,
    name: row.name,
    endpoint: row.endpoint,
    namespaces: [...row.approved_namespaces],
    resourceKinds: [...row.approved_resource_kinds] as ClusterScope["resourceKinds"],
  };
}

export class PostgresClusterScopeStore implements ClusterScopeStore {
  constructor(private readonly poolProvider: PoolProvider) {}

  async get(workspaceId: string): Promise<ClusterScope | null> {
    const pool = await this.poolProvider();
    const result = await pool.query<ClusterRow>(
      `SELECT id, workspace_id, name, endpoint, approved_namespaces, approved_resource_kinds
         FROM tracegarden_clusters WHERE workspace_id = $1`,
      [workspaceId],
    );
    const row = result.rows[0];
    return row ? clusterFromRow(row) : null;
  }

  async save(scope: ClusterScope): Promise<ClusterScope> {
    const pool = await this.poolProvider();
    const result = await pool.query<ClusterRow>(
      `INSERT INTO tracegarden_clusters
         (id, workspace_id, name, endpoint, approved_namespaces, approved_resource_kinds, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (workspace_id) DO UPDATE SET
         name = EXCLUDED.name,
         endpoint = EXCLUDED.endpoint,
         approved_namespaces = EXCLUDED.approved_namespaces,
         approved_resource_kinds = EXCLUDED.approved_resource_kinds,
         updated_at = now()
       RETURNING id, workspace_id, name, endpoint, approved_namespaces, approved_resource_kinds`,
      [scope.clusterId, scope.workspaceId, scope.name, scope.endpoint, scope.namespaces, scope.resourceKinds],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Cluster scope persistence returned no row");
    return clusterFromRow(row);
  }
}

type ObservationRow = Readonly<{
  id: string;
  workspace_id: string;
  cluster_id: string;
  kind: NormalizedObservation["kind"];
  source_identity: string;
  source_key: string;
  uid: string;
  name: string;
  namespace: string;
  resource_version: string | null;
  facts: Record<string, unknown>;
  observed_at: string | Date;
  ingestion_order: string | number;
}>;

type TimelineJoinRow = Readonly<{
  entry_id: string;
  entry_workspace_id: string;
  entry_cluster_id: string | null;
  entry_type: "observation" | "experiment";
  occurred_at: string | Date;
  timeline_sequence: string | number;
  observation_id: string | null;
  workspace_id: string | null;
  cluster_id: string | null;
  kind: NormalizedObservation["kind"] | null;
  source_identity: string | null;
  source_key: string | null;
  uid: string | null;
  name: string | null;
  namespace: string | null;
  resource_version: string | null;
  facts: Record<string, unknown> | null;
  observed_at: string | Date | null;
  ingestion_order: string | number | null;
  attention_item?: boolean;
  attention_unread?: boolean;
  experiment_id: string | null;
  experiment_workspace_id: string | null;
  experiment_created_by_member_id: string | null;
  hypothesis: string | null;
  change: string | null;
  observation: string | null;
  conclusion: string | null;
  state: ExperimentState | null;
  tags: string[] | null;
  git_revision: string | null;
  experiment_created_at: string | Date | null;
  experiment_updated_at: string | Date | null;
  experiment_workloads: readonly Record<string, unknown>[] | null;
}>;

type CheckpointRow = Readonly<{
  workspace_id: string;
  cluster_id: string;
  namespace: string;
  resource_kind: string;
  resource_version: string;
  updated_at: string | Date;
}>;

type CorrelationSuggestionRow = Readonly<{
  id: string;
  workspace_id: string;
  left_entry_id: string;
  right_entry_id: string;
  signals: string[];
  status: "pending" | "confirmed" | "rejected";
  created_at: string | Date;
  decided_at: string | Date | null;
  decided_by_member_id: string | null;
}>;

type ConfirmedLinkRow = Readonly<{
  id: string;
  workspace_id: string;
  suggestion_id: string;
  left_entry_id: string;
  right_entry_id: string;
  confirmed_by_member_id: string;
  confirmed_at: string | Date;
}>;

const correlationSignalValues: readonly CorrelationSignal[] = ["time", "ownership", "label", "revision"];

function correlationSuggestionFromRow(row: CorrelationSuggestionRow, confirmedLink?: ConfirmedLinkRecord): CorrelationSuggestionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    leftEntryId: row.left_entry_id,
    rightEntryId: row.right_entry_id,
    signals: row.signals.filter((signal): signal is CorrelationSignal => correlationSignalValues.includes(signal as CorrelationSignal)),
    status: row.status,
    createdAt: timestamp(row.created_at) ?? new Date(0).toISOString(),
    decidedAt: timestamp(row.decided_at),
    decidedByMemberId: row.decided_by_member_id,
    ...(confirmedLink ? { confirmedLink } : {}),
  };
}

function confirmedLinkFromRow(row: ConfirmedLinkRow): ConfirmedLinkRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    suggestionId: row.suggestion_id,
    leftEntryId: row.left_entry_id,
    rightEntryId: row.right_entry_id,
    confirmedByMemberId: row.confirmed_by_member_id,
    confirmedAt: timestamp(row.confirmed_at) ?? new Date(0).toISOString(),
  };
}

function normalizedFacts(observation: NormalizedObservation): Record<string, unknown> {
  return { ...observation };
}

function factString(facts: Record<string, unknown>, key: string): string | null {
  return typeof facts[key] === "string" ? facts[key] as string : null;
}

function factNumber(facts: Record<string, unknown>, key: string): number | null {
  const value = facts[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function factBoolean(facts: Record<string, unknown>, key: string): boolean | null {
  return typeof facts[key] === "boolean" ? facts[key] as boolean : null;
}

function factAttentionReason(facts: Record<string, unknown>): AttentionReasonCode | null {
  const value = facts.attentionReason;
  const codes: readonly AttentionReasonCode[] = [
    "condition_failed",
    "pod_not_ready",
    "deployment_replicas_unavailable",
    "statefulset_replicas_not_ready",
    "daemonset_nodes_not_ready",
    "replicaset_replicas_not_ready",
    "job_failed",
    "cronjob_suspended",
    "event_warning",
  ];
  return typeof value === "string" && codes.includes(value as AttentionReasonCode) ? value as AttentionReasonCode : null;
}

function commonObservation(row: ObservationRow): Omit<NormalizedObservation, "kind"> {
  const facts = row.facts;
  const rawClassification = factString(facts, "classification");
  const classification = rawClassification === "attention" || rawClassification === "recovery" ? rawClassification : "change";
  const rawOwners = facts.ownerReferences;
  const ownerReferences = Array.isArray(rawOwners) ? rawOwners.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const owner = item as Record<string, unknown>;
    if (typeof owner.kind !== "string" || typeof owner.name !== "string") return [];
    return [{ kind: owner.kind, name: owner.name, uid: typeof owner.uid === "string" ? owner.uid : null, controller: owner.controller === true }];
  }) : [];
  const rawLabels = facts.labels;
  const labels: Record<string, string> = {};
  if (typeof rawLabels === "object" && rawLabels !== null) {
    for (const [key, value] of Object.entries(rawLabels)) if (typeof value === "string") labels[key] = value;
  }
  return {
    workspaceId: row.workspace_id,
    clusterId: row.cluster_id,
    sourceIdentity: row.source_identity,
    sourceKey: row.source_key,
    uid: row.uid,
    name: row.name,
    namespace: row.namespace,
    resourceVersion: row.resource_version,
    classification,
    attention: factBoolean(facts, "attention") ?? classification === "attention",
    attentionReason: factAttentionReason(facts),
    recoveryOf: factString(facts, "recoveryOf"),
    reason: factString(facts, "reason"),
    message: factString(facts, "message"),
    ownerReferences,
    revision: factString(facts, "revision"),
    labels,
    observedAt: timestamp(row.observed_at) ?? new Date(0).toISOString(),
  };
}

function observationFromRow(row: ObservationRow): NormalizedObservation {
  const facts = row.facts;
  const common = commonObservation(row);
  switch (row.kind) {
    case "Deployment": return { ...common, kind: row.kind, desiredReplicas: factNumber(facts, "desiredReplicas"), availableReplicas: factNumber(facts, "availableReplicas"), readyReplicas: factNumber(facts, "readyReplicas"), updatedReplicas: factNumber(facts, "updatedReplicas"), unavailableReplicas: factNumber(facts, "unavailableReplicas") };
    case "StatefulSet": return { ...common, kind: row.kind, desiredReplicas: factNumber(facts, "desiredReplicas"), readyReplicas: factNumber(facts, "readyReplicas"), currentReplicas: factNumber(facts, "currentReplicas"), updatedReplicas: factNumber(facts, "updatedReplicas"), currentRevision: factString(facts, "currentRevision"), updateRevision: factString(facts, "updateRevision") };
    case "DaemonSet": return { ...common, kind: row.kind, desiredReplicas: factNumber(facts, "desiredReplicas"), currentReplicas: factNumber(facts, "currentReplicas"), readyReplicas: factNumber(facts, "readyReplicas"), updatedReplicas: factNumber(facts, "updatedReplicas"), availableReplicas: factNumber(facts, "availableReplicas"), unavailableReplicas: factNumber(facts, "unavailableReplicas") };
    case "ReplicaSet": return { ...common, kind: row.kind, desiredReplicas: factNumber(facts, "desiredReplicas"), currentReplicas: factNumber(facts, "currentReplicas"), readyReplicas: factNumber(facts, "readyReplicas"), availableReplicas: factNumber(facts, "availableReplicas") };
    case "Pod": return { ...common, kind: row.kind, phase: factString(facts, "phase"), ready: factBoolean(facts, "ready") };
    case "Job": return { ...common, kind: row.kind, desiredCompletions: factNumber(facts, "desiredCompletions"), active: factNumber(facts, "active"), succeeded: factNumber(facts, "succeeded"), failed: factNumber(facts, "failed"), completionTime: factString(facts, "completionTime") };
    case "CronJob": return { ...common, kind: row.kind, schedule: factString(facts, "schedule"), suspend: factBoolean(facts, "suspend"), active: factNumber(facts, "active"), lastScheduleTime: factString(facts, "lastScheduleTime"), lastSuccessfulTime: factString(facts, "lastSuccessfulTime") };
    case "Event": return { ...common, kind: row.kind, eventType: factString(facts, "eventType"), count: factNumber(facts, "count"), firstTimestamp: factString(facts, "firstTimestamp"), lastTimestamp: factString(facts, "lastTimestamp"), involvedKind: factString(facts, "involvedKind"), involvedName: factString(facts, "involvedName"), involvedNamespace: factString(facts, "involvedNamespace"), involvedUid: factString(facts, "involvedUid") };
  }
}

function workloadFromValue(value: Record<string, unknown>): ExperimentWorkload | null {
  const clusterId = value.clusterId;
  const namespace = value.namespace;
  const kind = value.kind;
  const name = value.name;
  if (typeof clusterId !== "string" || typeof namespace !== "string" || typeof kind !== "string" || typeof name !== "string") return null;
  return { clusterId, namespace, kind, name };
}

function experimentFromTimelineRow(row: TimelineJoinRow): ExperimentRecord {
  if (!row.experiment_id || !row.experiment_workspace_id || !row.experiment_created_by_member_id
    || row.hypothesis === null || row.change === null || row.observation === null || row.conclusion === null
    || row.state === null || !row.experiment_created_at || !row.experiment_updated_at) {
    throw new Error("Experiment Timeline entry is missing its Experiment");
  }
  const workloads = (row.experiment_workloads ?? []).flatMap((value) => {
    const workload = workloadFromValue(value);
    return workload ? [workload] : [];
  });
  return {
    id: row.experiment_id,
    workspaceId: row.experiment_workspace_id,
    timelineEntryId: row.entry_id,
    createdByMemberId: row.experiment_created_by_member_id,
    hypothesis: row.hypothesis,
    change: row.change,
    observation: row.observation,
    conclusion: row.conclusion,
    state: row.state,
    tags: [...(row.tags ?? [])],
    workloads,
    gitRevision: row.git_revision,
    createdAt: timestamp(row.experiment_created_at) ?? new Date(0).toISOString(),
    updatedAt: timestamp(row.experiment_updated_at) ?? new Date(0).toISOString(),
  };
}

function timelineEntryFromRow(row: TimelineJoinRow): StoredTimelineEntry {
  if (row.entry_type === "experiment") {
    return {
      id: row.entry_id,
      timelineSequence: String(row.timeline_sequence),
      workspaceId: row.entry_workspace_id,
      clusterId: row.entry_cluster_id,
      entryType: "experiment",
      occurredAt: timestamp(row.occurred_at) ?? new Date(0).toISOString(),
      experiment: experimentFromTimelineRow(row),
    };
  }
  if (!row.observation_id || !row.workspace_id || !row.cluster_id || !row.kind || !row.source_identity || !row.source_key || !row.uid || !row.name || !row.namespace || !row.facts || !row.observed_at) {
    throw new Error("Observation Timeline entry is missing its Observation");
  }
  const observation = observationFromRow({
    id: row.observation_id,
    workspace_id: row.workspace_id,
    cluster_id: row.cluster_id,
    kind: row.kind,
    source_identity: row.source_identity,
    source_key: row.source_key,
    uid: row.uid,
    name: row.name,
    namespace: row.namespace,
    resource_version: row.resource_version,
    facts: row.facts,
    observed_at: row.observed_at,
    ingestion_order: row.ingestion_order ?? 0,
  });
  return {
    id: row.entry_id,
    timelineSequence: String(row.timeline_sequence),
    workspaceId: row.entry_workspace_id,
    clusterId: row.entry_cluster_id ?? row.cluster_id,
    entryType: "observation",
    occurredAt: timestamp(row.occurred_at) ?? new Date(0).toISOString(),
    attentionItem: row.attention_item ?? observation.attention,
    attentionReason: observation.attentionReason,
    recoveryOf: observation.recoveryOf,
    observation,
    attention: row.attention_item ?? observation.attention,
    attentionUnread: row.attention_unread === true,
  };
}

const timelineSelect = `
  SELECT t.id AS entry_id, t.workspace_id AS entry_workspace_id, t.cluster_id AS entry_cluster_id,
         t.entry_type, t.occurred_at, t.timeline_sequence, o.id AS observation_id, o.workspace_id, o.cluster_id,
         o.kind, o.source_identity, o.source_key, o.uid, o.name, o.namespace,
         o.resource_version, o.facts, o.observed_at, o.ingestion_order,
         (ai.entry_id IS NOT NULL) AS attention_item,
         false AS attention_unread,
         e.id AS experiment_id, e.workspace_id AS experiment_workspace_id,
         e.created_by_member_id AS experiment_created_by_member_id, e.hypothesis, e.change,
         e.observation, e.conclusion, e.state, e.tags, e.git_revision,
         e.created_at AS experiment_created_at, e.updated_at AS experiment_updated_at,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
           'clusterId', ew.cluster_id, 'namespace', ew.namespace, 'kind', ew.kind, 'name', ew.name)
           ORDER BY ew.cluster_id, ew.namespace, ew.kind, ew.name)
           FROM tracegarden_experiment_workloads ew WHERE ew.experiment_id = e.id), '[]'::jsonb) AS experiment_workloads
    FROM tracegarden_timeline_entries t
    LEFT JOIN tracegarden_observations o ON o.id = t.observation_id
    LEFT JOIN tracegarden_experiments e ON e.id = t.experiment_id
    LEFT JOIN tracegarden_attention_items ai ON ai.entry_id = t.id`;

const observationSelect = `
  SELECT id, workspace_id, cluster_id, kind, source_identity, source_key, uid, name, namespace,
         resource_version, facts, observed_at, ingestion_order
    FROM tracegarden_observations`;

function checkpointFromRow(row: CheckpointRow): IngestionCheckpoint {
  return {
    workspaceId: row.workspace_id,
    clusterId: row.cluster_id,
    namespace: row.namespace,
    resourceKind: row.resource_kind,
    resourceVersion: row.resource_version,
    updatedAt: timestamp(row.updated_at) ?? new Date(0).toISOString(),
  };
}

async function validateExperimentClustersInDatabase(
  client: { query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }> },
  workspaceId: string,
  workloads: readonly ExperimentWorkload[],
): Promise<void> {
  const clusterIds = [...new Set(workloads.map((workload) => workload.clusterId))];
  if (clusterIds.length === 0) return;
  const result = await client.query<{ id: string }>(
    `SELECT id FROM tracegarden_clusters
      WHERE workspace_id = $1 AND id = ANY($2::text[])`,
    [workspaceId, clusterIds],
  );
  if (result.rows.length !== clusterIds.length) {
    throw new ExperimentValidationError([{
      field: "workloads",
      message: "must reference the Cluster configured for the Workspace",
    }]);
  }
}

const timelineWriterLock = "SELECT pg_advisory_xact_lock(hashtext('tracegarden:timeline:writer'))";

export class PostgresObservationStore implements TimelineStore, TimelineNotificationSource {
  private readonly timelineListeners = new Set<TimelineNotificationListener>();
  private timelineListenerClient: PoolClient | null = null;
  private timelineListenerHandler: ((message: { channel: string; payload?: string }) => void) | null = null;
  private timelineListenerErrorHandler: ((error: unknown) => void) | null = null;
  private timelineListenerSetup: Promise<void> | null = null;
  private timelineListenerHealthy = true;
  private readonly timelineErrorListeners = new Set<TimelineNotificationErrorListener>();

  constructor(private readonly poolProvider: PoolProvider, private readonly cursorSecret: string = DEFAULT_TIMELINE_CURSOR_SECRET) {
    if (!cursorSecret.trim()) throw new Error("Timeline cursor secret is required");
  }

  private async ensureTimelineListener(): Promise<void> {
    while (!this.timelineListenerClient) {
      if (!this.timelineListenerSetup) {
        this.timelineListenerHealthy = false;
        this.timelineListenerSetup = (async () => {
          const client = await (await this.poolProvider()).connect();
          let released = false;
          const release = (): void => {
            if (released) return;
            released = true;
            client.release();
          };
          const onNotification = (message: { channel: string; payload?: string }): void => {
            if (message.channel !== "tracegarden_timeline" || !message.payload) return;
            const notification = parseTimelineNotification(message.payload);
            if (!notification) return;
            for (const listener of this.timelineListeners) {
              try { listener(notification); } catch { /* notification listeners cannot affect persistence */ }
            }
          };
          const onError = (error: unknown): void => {
            if (this.timelineListenerClient !== client) return;
            this.timelineListenerClient = null;
            this.timelineListenerHandler = null;
            this.timelineListenerErrorHandler = null;
            this.timelineListenerHealthy = false;
            for (const listener of this.timelineErrorListeners) {
              try { listener(error); } catch { /* failure listeners cannot affect listener recovery */ }
            }
            release();
          };
          client.on("notification", onNotification);
          client.on("error", onError);
          this.timelineListenerClient = client;
          this.timelineListenerHandler = onNotification;
          this.timelineListenerErrorHandler = onError;
          try {
            await client.query("LISTEN tracegarden_timeline");
            this.timelineListenerHealthy = true;
          } catch (error) {
            client.removeListener("notification", onNotification);
            client.removeListener("error", onError);
            if (this.timelineListenerClient === client) this.timelineListenerClient = null;
            this.timelineListenerHandler = null;
            this.timelineListenerErrorHandler = null;
            release();
            throw error;
          }
        })().finally(() => {
          this.timelineListenerSetup = null;
        });
      }
      await this.timelineListenerSetup;
    }
  }

  private async releaseTimelineListener(): Promise<void> {
    await this.timelineListenerSetup?.catch(() => undefined);
    if (this.timelineListeners.size > 0) return;
    const client = this.timelineListenerClient;
    const handler = this.timelineListenerHandler;
    const errorHandler = this.timelineListenerErrorHandler;
    this.timelineListenerClient = null;
    this.timelineListenerHandler = null;
    this.timelineListenerErrorHandler = null;
    this.timelineListenerHealthy = true;
    if (!client) return;
    if (handler) client.removeListener("notification", handler);
    if (errorHandler) client.removeListener("error", errorHandler);
    await client.query("UNLISTEN tracegarden_timeline").catch(() => undefined);
    client.release();
  }

  async subscribeTimeline(listener: TimelineNotificationListener): Promise<() => void> {
    this.timelineListeners.add(listener);
    try {
      await this.ensureTimelineListener();
    } catch (error) {
      this.timelineListeners.delete(listener);
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.timelineListeners.delete(listener);
      if (this.timelineListeners.size === 0) void this.releaseTimelineListener();
    };
  }

  onTimelineError(listener: TimelineNotificationErrorListener): () => void {
    this.timelineErrorListeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.timelineErrorListeners.delete(listener);
    };
  }

  timelineNotificationsHealthy(): boolean {
    return this.timelineListenerHealthy;
  }

  private async validateObservationClusterInTransaction(
    client: { query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }> },
    observation: NormalizedObservation,
  ): Promise<void> {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM tracegarden_clusters WHERE workspace_id = $1 AND id = $2`,
      [observation.workspaceId, observation.clusterId],
    );
    if (!result.rows[0]) throw new Error("Observation Cluster does not belong to its Workspace");
  }

  private async recordObservationInTransaction(
    client: { query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }> },
    observation: NormalizedObservation,
  ): Promise<ObservationPersistenceResult> {
    await this.validateObservationClusterInTransaction(client, observation);
    const previousResult = await client.query<ObservationRow>(
      `${observationSelect}
        WHERE workspace_id = $1 AND cluster_id = $2 AND source_identity = $3
        ORDER BY ingestion_order DESC LIMIT 1`,
      [observation.workspaceId, observation.clusterId, observation.sourceIdentity],
    );
    const previous = previousResult.rows[0] ? observationFromRow(previousResult.rows[0]) : null;
    const storedObservation = markRecovery(observation, previous);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO tracegarden_observations
         (id, workspace_id, cluster_id, kind, source_identity, source_key, uid, name, namespace,
          resource_version, facts, observed_at, ingestion_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12,
               nextval('tracegarden_observation_ingestion_order_seq'))
       ON CONFLICT (workspace_id, cluster_id, source_key) DO NOTHING
       RETURNING id`,
      [
        randomUUID(), storedObservation.workspaceId, storedObservation.clusterId, storedObservation.kind,
        storedObservation.sourceIdentity, storedObservation.sourceKey, storedObservation.uid, storedObservation.name,
        storedObservation.namespace, storedObservation.resourceVersion, JSON.stringify(normalizedFacts(storedObservation)), storedObservation.observedAt,
      ],
    );
    const observationId = inserted.rows[0]?.id ?? (await client.query<{ id: string }>(
      `SELECT id FROM tracegarden_observations
        WHERE workspace_id = $1 AND cluster_id = $2 AND source_key = $3`,
      [observation.workspaceId, observation.clusterId, observation.sourceKey],
    )).rows[0]?.id;
    if (!observationId) throw new Error("Observation persistence returned no row");
    const duplicate = !inserted.rows[0];
    await client.query(
      `INSERT INTO tracegarden_timeline_entries
         (id, workspace_id, cluster_id, entry_type, observation_id, occurred_at)
       VALUES ($1, $2, $3, 'observation', $4, $5)
       ON CONFLICT (observation_id) DO NOTHING`,
      [randomUUID(), observation.workspaceId, observation.clusterId, observationId, storedObservation.observedAt],
    );
    if (!duplicate && isAttentionObservation(observation)) {
      await client.query(
        `INSERT INTO tracegarden_attention_items (entry_id, workspace_id)
         SELECT id, workspace_id FROM tracegarden_timeline_entries
          WHERE observation_id = $1
         ON CONFLICT (entry_id) DO NOTHING`,
        [observationId],
      );
    }
    const result = await client.query<TimelineJoinRow>(`${timelineSelect} WHERE t.observation_id = $1`, [observationId]);
    const row = result.rows[0];
    if (!row) throw new Error("Timeline persistence returned no row");
    const entry = timelineEntryFromRow(row);
    if (entry.entryType !== "observation") throw new Error("Observation persistence returned the wrong Timeline entry");
    return { observation: entry.observation, entry, duplicate };
  }

  private async validateCheckpointClusterInTransaction(
    client: { query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }> },
    checkpoint: Pick<IngestionCheckpointInput, "workspaceId" | "clusterId">,
  ): Promise<void> {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM tracegarden_clusters WHERE workspace_id = $1 AND id = $2`,
      [checkpoint.workspaceId, checkpoint.clusterId],
    );
    if (!result.rows[0]) throw new Error("Ingestion Checkpoint Cluster does not belong to its Workspace");
  }

  private async saveCheckpointInTransaction(
    client: { query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }> },
    checkpoint: IngestionCheckpointInput,
  ): Promise<void> {
    await this.validateCheckpointClusterInTransaction(client, checkpoint);
    await client.query(
      `INSERT INTO tracegarden_ingestion_checkpoints
         (workspace_id, cluster_id, namespace, resource_kind, resource_version)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, cluster_id, namespace, resource_kind) DO UPDATE SET
         resource_version = CASE
           WHEN tracegarden_ingestion_checkpoints.resource_version ~ '^[0-9]+$'
                AND EXCLUDED.resource_version ~ '^[0-9]+$'
             THEN GREATEST(tracegarden_ingestion_checkpoints.resource_version::numeric, EXCLUDED.resource_version::numeric)::text
           ELSE EXCLUDED.resource_version
         END,
         updated_at = CASE
           WHEN tracegarden_ingestion_checkpoints.resource_version ~ '^[0-9]+$'
                AND EXCLUDED.resource_version ~ '^[0-9]+$'
                AND EXCLUDED.resource_version::numeric > tracegarden_ingestion_checkpoints.resource_version::numeric
             THEN now()
           WHEN NOT (tracegarden_ingestion_checkpoints.resource_version ~ '^[0-9]+$'
                     AND EXCLUDED.resource_version ~ '^[0-9]+$')
                AND EXCLUDED.resource_version <> tracegarden_ingestion_checkpoints.resource_version
             THEN now()
           ELSE tracegarden_ingestion_checkpoints.updated_at
         END`,
      [checkpoint.workspaceId, checkpoint.clusterId, checkpoint.namespace, checkpoint.resourceKind, checkpoint.resourceVersion],
    );
  }

  private async advanceCheckpointInTransaction(
    client: { query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }> },
    checkpoint: IngestionCheckpointInput,
  ): Promise<void> {
    await this.validateCheckpointClusterInTransaction(client, checkpoint);
    await client.query(
      `INSERT INTO tracegarden_ingestion_checkpoints
         (workspace_id, cluster_id, namespace, resource_kind, resource_version)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, cluster_id, namespace, resource_kind) DO UPDATE SET
         resource_version = CASE
           WHEN tracegarden_ingestion_checkpoints.resource_version ~ '^[0-9]+$'
                AND EXCLUDED.resource_version ~ '^[0-9]+$'
             THEN GREATEST(tracegarden_ingestion_checkpoints.resource_version::numeric, EXCLUDED.resource_version::numeric)::text
           ELSE EXCLUDED.resource_version
         END,
         updated_at = CASE
           WHEN tracegarden_ingestion_checkpoints.resource_version ~ '^[0-9]+$'
                AND EXCLUDED.resource_version ~ '^[0-9]+$'
                AND EXCLUDED.resource_version::numeric > tracegarden_ingestion_checkpoints.resource_version::numeric
             THEN now()
           WHEN NOT (tracegarden_ingestion_checkpoints.resource_version ~ '^[0-9]+$'
                     AND EXCLUDED.resource_version ~ '^[0-9]+$')
                AND EXCLUDED.resource_version <> tracegarden_ingestion_checkpoints.resource_version
             THEN now()
           ELSE tracegarden_ingestion_checkpoints.updated_at
         END`,
      [checkpoint.workspaceId, checkpoint.clusterId, checkpoint.namespace, checkpoint.resourceKind, checkpoint.resourceVersion],
    );
  }

  async recordObservation(observation: NormalizedObservation): Promise<ObservationPersistenceResult> {
    const results = await this.recordObservations([observation]);
    const result = results[0];
    if (!result) throw new Error("Observation persistence returned no row");
    return result;
  }

  async recordObservations(observations: readonly NormalizedObservation[]): Promise<readonly ObservationPersistenceResult[]> {
    if (observations.length === 0) return [];
    const pool = await this.poolProvider();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(timelineWriterLock);
      const lockTargets = [...new Map(observations.map((observation) => [
        `${observation.workspaceId}\u0000${observation.clusterId}\u0000${observation.sourceIdentity}`,
        observation,
      ]))].sort(([left], [right]) => left.localeCompare(right));
      for (const [, observation] of lockTargets) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2 || ':' || $3))",
          [observation.workspaceId, observation.clusterId, observation.sourceIdentity],
        );
      }
      const results: ObservationPersistenceResult[] = [];
      for (const observation of observations) results.push(await this.recordObservationInTransaction(client, observation));
      await client.query("COMMIT");
      for (const workspaceId of new Set(observations.map((observation) => observation.workspaceId))) await this.refreshCorrelationSuggestions(workspaceId);
      return results;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error("Tracegarden observation persistence failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async recordObservationsAndCheckpoint(
    observations: readonly NormalizedObservation[],
    checkpoint: IngestionCheckpointInput,
  ): Promise<readonly ObservationPersistenceResult[]> {
    const pool = await this.poolProvider();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(timelineWriterLock);
      const results: ObservationPersistenceResult[] = [];
      for (const observation of observations) results.push(await this.recordObservationInTransaction(client, observation));
      await this.saveCheckpointInTransaction(client, checkpoint);
      await client.query("COMMIT");
      for (const workspaceId of new Set(observations.map((observation) => observation.workspaceId))) await this.refreshCorrelationSuggestions(workspaceId);
      return results;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error("Tracegarden observation checkpoint persistence failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async getIngestionCheckpoint(workspaceId: string, clusterId: string, resourceKind: string, namespace: string): Promise<IngestionCheckpoint | null> {
    const pool = await this.poolProvider();
    const result = await pool.query<CheckpointRow>(
      `SELECT workspace_id, cluster_id, namespace, resource_kind, resource_version, updated_at
         FROM tracegarden_ingestion_checkpoints
        WHERE workspace_id = $1 AND cluster_id = $2 AND namespace = $3 AND resource_kind = $4`,
      [workspaceId, clusterId, namespace, resourceKind],
    );
    return result.rows[0] ? checkpointFromRow(result.rows[0]) : null;
  }

  async advanceIngestionCheckpoint(checkpoint: IngestionCheckpointInput): Promise<IngestionCheckpoint | null> {
    const pool = await this.poolProvider();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await this.advanceCheckpointInTransaction(client, checkpoint);
      const result = await client.query<CheckpointRow>(
        `SELECT workspace_id, cluster_id, namespace, resource_kind, resource_version, updated_at
           FROM tracegarden_ingestion_checkpoints
          WHERE workspace_id = $1 AND cluster_id = $2 AND namespace = $3 AND resource_kind = $4`,
        [checkpoint.workspaceId, checkpoint.clusterId, checkpoint.namespace, checkpoint.resourceKind],
      );
      await client.query("COMMIT");
      return result.rows[0] ? checkpointFromRow(result.rows[0]) : null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error("Tracegarden ingestion checkpoint persistence failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async clearIngestionCheckpoint(checkpoint: Omit<IngestionCheckpointInput, "resourceVersion">): Promise<void> {
    const pool = await this.poolProvider();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await this.validateCheckpointClusterInTransaction(client, checkpoint);
      await client.query(
        `DELETE FROM tracegarden_ingestion_checkpoints
          WHERE workspace_id = $1 AND cluster_id = $2 AND namespace = $3 AND resource_kind = $4`,
        [checkpoint.workspaceId, checkpoint.clusterId, checkpoint.namespace, checkpoint.resourceKind],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error("Tracegarden ingestion checkpoint clearing failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async createExperiment(workspaceId: string, createdByMemberId: string, input: unknown): Promise<ExperimentRecord> {
    const timelineEntryId = randomUUID();
    const experiment = createExperimentRecord(workspaceId, createdByMemberId, timelineEntryId, input);
    const pool = await this.poolProvider();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(timelineWriterLock);
      await validateExperimentClustersInDatabase(client, workspaceId, experiment.workloads);
      await client.query(
        `INSERT INTO tracegarden_experiments
           (id, workspace_id, created_by_member_id, hypothesis, change, observation, conclusion, state, tags, git_revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
        [experiment.id, workspaceId, createdByMemberId, experiment.hypothesis, experiment.change, experiment.observation,
          experiment.conclusion, experiment.state, experiment.tags, experiment.gitRevision, experiment.createdAt],
      );
      for (const workload of experiment.workloads) {
        await client.query(
          `INSERT INTO tracegarden_experiment_workloads
             (experiment_id, workspace_id, cluster_id, namespace, kind, name)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [experiment.id, workspaceId, workload.clusterId, workload.namespace, workload.kind, workload.name],
        );
      }
      await client.query(
        `INSERT INTO tracegarden_timeline_entries
           (id, workspace_id, cluster_id, entry_type, experiment_id, occurred_at)
         VALUES ($1, $2, $3, 'experiment', $4, $5)`,
        [timelineEntryId, workspaceId, experiment.workloads[0]?.clusterId ?? null, experiment.id, experiment.createdAt],
      );
      await client.query("COMMIT");
      const result = await pool.query<TimelineJoinRow>(`${timelineSelect} WHERE t.id = $1`, [timelineEntryId]);
      const row = result.rows[0];
      if (!row) throw new Error("Experiment persistence returned no row");
      const entry = timelineEntryFromRow(row);
      if (entry.entryType !== "experiment") throw new Error("Experiment persistence returned the wrong Timeline entry");
      await this.refreshCorrelationSuggestions(workspaceId);
      return cloneExperiment(entry.experiment);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof ExperimentValidationError) throw error;
      throw new Error("Tracegarden Experiment persistence failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async updateExperiment(workspaceId: string, id: string, input: unknown): Promise<ExperimentRecord | null> {
    const pool = await this.poolProvider();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(timelineWriterLock);
      const locked = await client.query<{ id: string }>(
        "SELECT id FROM tracegarden_experiments WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [id, workspaceId],
      );
      if (!locked.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const currentResult = await client.query<TimelineJoinRow>(`${timelineSelect} WHERE t.experiment_id = $1 AND t.workspace_id = $2`, [id, workspaceId]);
      const currentRow = currentResult.rows[0];
      if (!currentRow || currentRow.entry_type !== "experiment") throw new Error("Experiment Timeline entry is missing");
      const current = experimentFromTimelineRow(currentRow);
      const updated = updateExperimentRecord(current, input);
      await validateExperimentClustersInDatabase(client, workspaceId, updated.workloads);
      await client.query(
        `UPDATE tracegarden_experiments
            SET hypothesis = $1, change = $2, observation = $3, conclusion = $4,
                state = $5, tags = $6, git_revision = $7, updated_at = $8
          WHERE id = $9 AND workspace_id = $10`,
        [updated.hypothesis, updated.change, updated.observation, updated.conclusion, updated.state,
          updated.tags, updated.gitRevision, updated.updatedAt, id, workspaceId],
      );
      await client.query("DELETE FROM tracegarden_experiment_workloads WHERE experiment_id = $1", [id]);
      for (const workload of updated.workloads) {
        await client.query(
          `INSERT INTO tracegarden_experiment_workloads
             (experiment_id, workspace_id, cluster_id, namespace, kind, name)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, workspaceId, workload.clusterId, workload.namespace, workload.kind, workload.name],
        );
      }
      await client.query(
        "UPDATE tracegarden_timeline_entries SET cluster_id = $1 WHERE id = $2 AND workspace_id = $3",
        [updated.workloads[0]?.clusterId ?? null, current.timelineEntryId, workspaceId],
      );
      await client.query("COMMIT");
      const result = await pool.query<TimelineJoinRow>(`${timelineSelect} WHERE t.experiment_id = $1 AND t.workspace_id = $2`, [id, workspaceId]);
      const row = result.rows[0];
      if (!row) throw new Error("Experiment update returned no row");
      const entry = timelineEntryFromRow(row);
      if (entry.entryType !== "experiment") throw new Error("Experiment update returned the wrong Timeline entry");
      await this.refreshCorrelationSuggestions(workspaceId);
      return cloneExperiment(entry.experiment);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof Error && (error.name === "ExperimentValidationError" || error.name === "ExperimentLifecycleError")) throw error;
      throw new Error("Tracegarden Experiment update failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async getExperiment(workspaceId: string, id: string): Promise<ExperimentRecord | null> {
    const pool = await this.poolProvider();
    const result = await pool.query<TimelineJoinRow>(`${timelineSelect} WHERE t.workspace_id = $1 AND t.experiment_id = $2`, [workspaceId, id]);
    const row = result.rows[0];
    if (!row) return null;
    const entry = timelineEntryFromRow(row);
    if (entry.entryType !== "experiment") return null;
    const links = await this.listConfirmedLinks(workspaceId, entry.id);
    return cloneExperiment(links.length > 0 ? { ...entry.experiment, confirmedLinks: links } : entry.experiment);
  }

  async listExperiments(workspaceId: string): Promise<readonly ExperimentRecord[]> {
    const pool = await this.poolProvider();
    const result = await pool.query<TimelineJoinRow>(`${timelineSelect} WHERE t.workspace_id = $1 AND t.entry_type = 'experiment' ORDER BY t.timeline_sequence`, [workspaceId]);
    const links = await this.listConfirmedLinks(workspaceId);
    return Object.freeze(result.rows.map((row) => {
      const entry = timelineEntryFromRow(row);
      if (entry.entryType !== "experiment") throw new Error("Experiment query returned the wrong Timeline entry");
      const related = links.filter((link) => link.leftEntryId === entry.id || link.rightEntryId === entry.id);
      return cloneExperiment(related.length > 0 ? { ...entry.experiment, confirmedLinks: related } : entry.experiment);
    }));
  }

  private async allTimelineEntriesForCorrelation(workspaceId: string): Promise<readonly TimelineEntry[]> {
    const entries: TimelineEntry[] = [];
    let cursor: string | undefined;
    while (true) {
      const page = await this.listTimelineEntries(workspaceId, { limit: 100, ...(cursor ? { cursor } : {}) });
      entries.push(...page.entries);
      if (!page.nextCursor) return entries;
      cursor = page.nextCursor;
    }
  }

  private async refreshCorrelationSuggestions(workspaceId: string): Promise<void> {
    const candidates = suggestCorrelationCandidates((await this.allTimelineEntriesForCorrelation(workspaceId)).map(correlationEntryFor));
    if (candidates.length === 0) return;
    const pool = await this.poolProvider();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const candidate of candidates) {
        await client.query(
          `INSERT INTO tracegarden_correlation_suggestions
             (id, workspace_id, left_entry_id, right_entry_id, signals, status, created_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6)
           ON CONFLICT (workspace_id, left_entry_id, right_entry_id) DO UPDATE SET signals = EXCLUDED.signals`,
          [candidate.id, candidate.workspaceId, candidate.leftEntryId, candidate.rightEntryId, candidate.signals, candidate.createdAt],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error("Tracegarden Correlation Suggestion persistence failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async listCorrelationSuggestions(workspaceId: string): Promise<readonly CorrelationSuggestionRecord[]> {
    await this.refreshCorrelationSuggestions(workspaceId);
    const pool = await this.poolProvider();
    const result = await pool.query<CorrelationSuggestionRow>(
      `SELECT id, workspace_id, left_entry_id, right_entry_id, signals, status, created_at, decided_at, decided_by_member_id
         FROM tracegarden_correlation_suggestions
        WHERE workspace_id = $1 AND status = 'pending'
        ORDER BY created_at, id`,
      [workspaceId],
    );
    return Object.freeze(result.rows.map((row) => correlationSuggestionFromRow(row)));
  }

  async getCorrelationSuggestion(workspaceId: string, id: string): Promise<CorrelationSuggestionRecord | null> {
    await this.refreshCorrelationSuggestions(workspaceId);
    const pool = await this.poolProvider();
    const result = await pool.query<CorrelationSuggestionRow>(
      `SELECT id, workspace_id, left_entry_id, right_entry_id, signals, status, created_at, decided_at, decided_by_member_id
         FROM tracegarden_correlation_suggestions WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id],
    );
    const row = result.rows[0];
    if (!row) return null;
    const links = await this.listConfirmedLinks(workspaceId);
    return correlationSuggestionFromRow(row, links.find((link) => link.suggestionId === id));
  }

  async decideCorrelationSuggestion(workspaceId: string, id: string, memberId: string, decision: CorrelationDecision): Promise<CorrelationDecisionResult | null> {
    if (!workspaceId.trim() || !id.trim() || !memberId.trim()) throw new Error("Correlation decision identifiers are required");
    await this.refreshCorrelationSuggestions(workspaceId);
    const pool = await this.poolProvider();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<CorrelationSuggestionRow>(
        `SELECT id, workspace_id, left_entry_id, right_entry_id, signals, status, created_at, decided_at, decided_by_member_id
           FROM tracegarden_correlation_suggestions
          WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [workspaceId, id],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      if (row.status !== "pending") {
        if ((decision === "confirm") !== (row.status === "confirmed")) {
          await client.query("COMMIT");
          throw new CorrelationDecisionConflictError(row.status);
        }
        const existing = await client.query<ConfirmedLinkRow>(
          `SELECT id, workspace_id, suggestion_id, left_entry_id, right_entry_id, confirmed_by_member_id, confirmed_at
             FROM tracegarden_confirmed_links WHERE suggestion_id = $1`,
          [id],
        );
        await client.query("COMMIT");
        const link = existing.rows[0] ? confirmedLinkFromRow(existing.rows[0]) : null;
        return { suggestion: correlationSuggestionFromRow(row, link ?? undefined), confirmedLink: link, idempotent: true };
      }
      const now = new Date().toISOString();
      let link: ConfirmedLinkRecord | null = null;
      if (decision === "confirm") {
        const inserted = await client.query<ConfirmedLinkRow>(
          `INSERT INTO tracegarden_confirmed_links
             (id, workspace_id, suggestion_id, left_entry_id, right_entry_id, confirmed_by_member_id, confirmed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (suggestion_id) DO UPDATE SET suggestion_id = EXCLUDED.suggestion_id
           RETURNING id, workspace_id, suggestion_id, left_entry_id, right_entry_id, confirmed_by_member_id, confirmed_at`,
          [randomUUID(), workspaceId, id, row.left_entry_id, row.right_entry_id, memberId, now],
        );
        link = inserted.rows[0] ? confirmedLinkFromRow(inserted.rows[0]) : null;
      }
      await client.query(
        `UPDATE tracegarden_correlation_suggestions
            SET status = $1, decided_at = $2, decided_by_member_id = $3
          WHERE id = $4 AND workspace_id = $5`,
        [decision === "confirm" ? "confirmed" : "rejected", now, memberId, id, workspaceId],
      );
      await client.query("COMMIT");
      const suggestion = { ...correlationSuggestionFromRow({ ...row, status: decision === "confirm" ? "confirmed" : "rejected", decided_at: now, decided_by_member_id: memberId }, link ?? undefined) };
      return { suggestion, confirmedLink: link, idempotent: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof CorrelationDecisionConflictError) throw error;
      throw new Error("Tracegarden Correlation Suggestion decision failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async listConfirmedLinks(workspaceId: string, entryId?: string): Promise<readonly ConfirmedLinkRecord[]> {
    const pool = await this.poolProvider();
    const values: unknown[] = [workspaceId];
    const condition = entryId === undefined ? "" : ` AND (left_entry_id = $2 OR right_entry_id = $2)`;
    if (entryId !== undefined) values.push(entryId);
    const result = await pool.query<ConfirmedLinkRow>(
      `SELECT id, workspace_id, suggestion_id, left_entry_id, right_entry_id, confirmed_by_member_id, confirmed_at
         FROM tracegarden_confirmed_links WHERE workspace_id = $1${condition} ORDER BY confirmed_at, id`,
      values,
    );
    return Object.freeze(result.rows.map(confirmedLinkFromRow));
  }

  private async attachConfirmedLinks(workspaceId: string, entries: readonly TimelineEntry[]): Promise<readonly TimelineEntry[]> {
    const links = await this.listConfirmedLinks(workspaceId);
    return entries.map((entry) => {
      const related = links.filter((link) => link.leftEntryId === entry.id || link.rightEntryId === entry.id);
      return related.length > 0 ? { ...entry, confirmedLinks: related } : entry;
    });
  }

  async listTimelineEntries(workspaceId: string, query: TimelineQuery, memberId?: string): Promise<TimelinePage> {
    if (query.unread !== undefined && memberId === undefined) {
      throw new TimelineQueryValidationError(["member is required for unread Attention filtering"]);
    }
    const cursor = query.cursor ? decodeTimelineCursor(query.cursor, query, this.cursorSecret, memberId) : null;
    const pool = await this.poolProvider();
    const values: unknown[] = [workspaceId];
    let condition = "t.workspace_id = $1";
    let joins = " LEFT JOIN tracegarden_attention_reviews ar ON false";
    if (memberId !== undefined) {
      values.push(memberId);
      joins = ` LEFT JOIN tracegarden_attention_reviews ar ON ar.entry_id = ai.entry_id AND ar.member_id = $${values.length}`;
    }
    if (cursor) {
      values.push(cursor.sequence);
      condition += ` AND t.timeline_sequence > $${values.length}::bigint`;
    }
    if (query.kind) {
      values.push(query.kind);
      condition += ` AND o.kind = $${values.length}`;
    }
    if (query.namespace) {
      values.push(query.namespace);
      condition += ` AND o.namespace = $${values.length}`;
    }
    if (query.name) {
      values.push(query.name);
      condition += ` AND o.name = $${values.length}`;
    }
    if (query.state) {
      values.push(query.state);
      condition += ` AND o.facts->>'phase' = $${values.length}`;
    }
    if (query.attention !== undefined) condition += query.attention ? " AND ai.entry_id IS NOT NULL" : " AND ai.entry_id IS NULL";
    if (query.unread !== undefined) condition += query.unread ? " AND ai.entry_id IS NOT NULL AND ar.entry_id IS NULL" : " AND (ai.entry_id IS NULL OR ar.entry_id IS NOT NULL)";
    values.push(query.limit + 1);
    const attentionUnreadSelect = memberId === undefined
      ? "false AS attention_unread"
      : "(ai.entry_id IS NOT NULL AND ar.entry_id IS NULL) AS attention_unread";
    const listSelect = timelineSelect.replace("         false AS attention_unread", `         ${attentionUnreadSelect}`) + joins;
    const result = await pool.query<TimelineJoinRow>(`${listSelect} WHERE ${condition} ORDER BY t.timeline_sequence LIMIT $${values.length}`, values);
    const rawEntries = result.rows.slice(0, query.limit).map(timelineEntryFromRow);
    const entries = await this.attachConfirmedLinks(workspaceId, rawEntries);
    return {
      entries,
      nextCursor: result.rows.length > query.limit && entries.length > 0 ? encodeTimelineCursor(entries[entries.length - 1] as StoredTimelineEntry, query, this.cursorSecret, memberId) : null,
      ...(memberId !== undefined && entries.length > 0 ? { resumeCursor: encodeTimelineCursor(entries[entries.length - 1] as StoredTimelineEntry, query, this.cursorSecret, memberId) } : {}),
      ...(memberId === undefined ? {} : { unreadAttentionCount: await this.unreadAttentionCount(workspaceId, memberId) }),
    };
  }

  async countTimelineEntriesAfterCursor(workspaceId: string, query: TimelineQuery, memberId?: string): Promise<number> {
    const page = await this.listTimelineEntries(workspaceId, { ...query, limit: 100 }, memberId);
    let count = page.entries.length;
    let nextCursor = page.nextCursor;
    while (nextCursor) {
      const nextPage = await this.listTimelineEntries(workspaceId, { ...query, limit: 100, cursor: nextCursor }, memberId);
      count += nextPage.entries.length;
      nextCursor = nextPage.nextCursor;
    }
    return count;
  }

  async getTimelineEntry(workspaceId: string, id: string): Promise<TimelineEntry | null> {
    const pool = await this.poolProvider();
    const result = await pool.query<TimelineJoinRow>(`${timelineSelect} WHERE t.workspace_id = $1 AND t.id = $2`, [workspaceId, id]);
    if (!result.rows[0]) return null;
    const entry = timelineEntryFromRow(result.rows[0]);
    const links = await this.listConfirmedLinks(workspaceId, id);
    return links.length > 0 ? { ...entry, confirmedLinks: links } : entry;
  }

  async unreadAttentionCount(workspaceId: string, memberId: string): Promise<number> {
    const pool = await this.poolProvider();
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM tracegarden_attention_items ai
         JOIN tracegarden_timeline_entries t ON t.id = ai.entry_id
        WHERE ai.workspace_id = $1
          AND NOT EXISTS (SELECT 1 FROM tracegarden_attention_reviews ar WHERE ar.entry_id = ai.entry_id AND ar.member_id = $2)`,
      [workspaceId, memberId],
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  async reviewAttentionItem(workspaceId: string, memberId: string, entryId: string): Promise<AttentionReviewResult | null> {
    if (!workspaceId.trim() || !memberId.trim() || !entryId.trim()) throw new Error("Attention review identifiers are required");
    const pool = await this.poolProvider();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const item = await client.query<{ entry_id: string }>(
        `SELECT ai.entry_id
           FROM tracegarden_attention_items ai
           JOIN tracegarden_timeline_entries t ON t.id = ai.entry_id
          WHERE ai.workspace_id = $1 AND t.workspace_id = $1 AND ai.entry_id = $2`,
        [workspaceId, entryId],
      );
      if (!item.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const reviewed = await client.query(
        `INSERT INTO tracegarden_attention_reviews (entry_id, member_id)
         VALUES ($1, $2) ON CONFLICT (entry_id, member_id) DO NOTHING`,
        [entryId, memberId],
      );
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM tracegarden_attention_items ai
          WHERE ai.workspace_id = $1
            AND NOT EXISTS (SELECT 1 FROM tracegarden_attention_reviews ar WHERE ar.entry_id = ai.entry_id AND ar.member_id = $2)`,
        [workspaceId, memberId],
      );
      await client.query("COMMIT");
      return { entryId, reviewed: reviewed.rowCount === 1, unreadCount: Number(count.rows[0]?.count ?? "0") };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error("Tracegarden Attention review failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async countObservations(workspaceId: string): Promise<number> {
    const pool = await this.poolProvider();
    const result = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM tracegarden_observations WHERE workspace_id = $1", [workspaceId]);
    return Number(result.rows[0]?.count ?? "0");
  }

  async countTimelineEntries(workspaceId: string): Promise<number> {
    const pool = await this.poolProvider();
    const result = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM tracegarden_timeline_entries WHERE workspace_id = $1", [workspaceId]);
    return Number(result.rows[0]?.count ?? "0");
  }
}

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

export class PostgresAdmissionStore implements AdmissionStore, MembershipStore, LogAuditStore {
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

  async recordLogAccess(actor: Pick<MemberRecord, "id">, metadata: LogAccessAuditMetadata): Promise<void> {
    const pool = await this.poolProvider();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await this.audit(client, "log.accessed", "log_window", randomUUID(), actor.id, {
        clusterId: metadata.clusterId,
        namespace: metadata.namespace,
        pod: metadata.pod,
        container: metadata.container,
        tail: metadata.tail,
        lineCount: metadata.lineCount,
        byteCount: metadata.byteCount,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error("Tracegarden log access audit failed");
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
  readonly clusterScope: ClusterScopeStore;
  readonly timeline: PostgresObservationStore;
  readonly experiments: ExperimentStore;

  constructor(
    private readonly connectionString: string,
    bootstrapIdentity: BootstrapIdentity = DEFAULT_LOCAL_BOOTSTRAP,
    cursorSecret: string = DEFAULT_TIMELINE_CURSOR_SECRET,
  ) {
    if (!cursorSecret.trim()) throw new Error("Timeline cursor secret is required");
    const poolProvider = () => this.getPool();
    this.admission = new PostgresAdmissionStore(poolProvider, bootstrapIdentity);
    this.clusterScope = new PostgresClusterScopeStore(poolProvider);
    this.timeline = new PostgresObservationStore(poolProvider, cursorSecret);
    this.experiments = this.timeline;
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
    const client = await pool.connect();
    let failed = false;
    let failure: unknown;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["tracegarden:migrations"]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS tracegarden_schema_migrations (
          id text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      for (const migration of migrations) {
        const applied = await client.query<{ id: string }>(
          "SELECT id FROM tracegarden_schema_migrations WHERE id = $1",
          [migration.id],
        );
        if (applied.rows.length > 0) continue;
        const migrationPath = fileURLToPath(new URL(migration.path, import.meta.url));
        const migrationSql = await readFile(migrationPath, "utf8");
        await client.query(migrationSql);
        await client.query(
          "INSERT INTO tracegarden_schema_migrations (id) VALUES ($1)",
          [migration.id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      failed = true;
      failure = error;
      await client.query("ROLLBACK").catch(() => undefined);
    } finally {
      client.release();
    }
    if (failed) {
      await this.close();
      throw new Error("Tracegarden database migration failed", { cause: failure });
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
    const pool = this.pool;
    this.pool = undefined;
    if (pool) await pool.end();
  }
}

export class MemoryDatabase implements DatabaseBoundary {
  readonly kind = "memory" as const;
  readonly admission: MemoryAdmissionStore;
  readonly clusterScope: MemoryClusterScopeStore;
  readonly timeline: MemoryObservationStore;
  readonly experiments: ExperimentStore;
  private migrationReady = false;

  constructor(bootstrapIdentity: BootstrapIdentity = DEFAULT_LOCAL_BOOTSTRAP) {
    this.admission = new MemoryAdmissionStore(bootstrapIdentity);
    this.clusterScope = new MemoryClusterScopeStore();
    this.timeline = new MemoryObservationStore(this.clusterScope);
    this.experiments = this.timeline;
  }

  async migrate(): Promise<void> {
    this.migrationReady = true;
  }

  async ping(): Promise<boolean> {
    return this.migrationReady;
  }

  async close(): Promise<void> {}
}

export { MemoryClusterScopeStore };

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
  const cursorSecret = environment.TIMELINE_CURSOR_SECRET?.trim();
  if (environment.NODE_ENV === "production" && !cursorSecret) {
    throw new Error("TIMELINE_CURSOR_SECRET is required in production");
  }
  return new PostgresDatabase(connectionString, bootstrapIdentity, cursorSecret ?? DEFAULT_TIMELINE_CURSOR_SECRET);
}
