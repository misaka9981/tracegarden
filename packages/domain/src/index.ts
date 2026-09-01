import { randomUUID } from "node:crypto";
import { isValidClusterId, isValidNamespace } from "../../cluster/src/index.js";
import { capabilities, requireCapability, type MemberRecord } from "../../identity/src/index.js";

export const EXPERIMENT_STATES = ["draft", "active", "concluded", "abandoned"] as const;
export type ExperimentState = (typeof EXPERIMENT_STATES)[number];

export type ExperimentWorkload = Readonly<{
  clusterId: string;
  namespace: string;
  kind: string;
  name: string;
}>;

export type ConfirmedLinkRecord = Readonly<{
  id: string;
  workspaceId: string;
  suggestionId: string;
  leftEntryId: string;
  rightEntryId: string;
  confirmedByMemberId: string;
  confirmedAt: string;
}>;

export type ExperimentRecord = Readonly<{
  id: string;
  workspaceId: string;
  timelineEntryId: string;
  createdByMemberId: string;
  hypothesis: string;
  change: string;
  observation: string;
  conclusion: string;
  state: ExperimentState;
  tags: readonly string[];
  workloads: readonly ExperimentWorkload[];
  gitRevision: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedLinks?: readonly ConfirmedLinkRecord[];
}>;

export type ExperimentInput = Readonly<{
  hypothesis: string;
  change: string;
  observation: string;
  conclusion: string;
  state: ExperimentState;
  tags: readonly string[];
  workloads: readonly ExperimentWorkload[];
  gitRevision: string | null;
}>;

export type ExperimentUpdateInput = Readonly<Partial<ExperimentInput>>;

export type ExperimentValidationIssue = Readonly<{ field: string; message: string }>;

export class ExperimentValidationError extends Error {
  constructor(readonly issues: readonly ExperimentValidationIssue[]) {
    super("Invalid Experiment");
    this.name = "ExperimentValidationError";
  }
}

export class ExperimentLifecycleError extends Error {
  constructor(readonly from: ExperimentState, readonly to: ExperimentState) {
    super(`Invalid Experiment lifecycle transition: ${from} -> ${to}`);
    this.name = "ExperimentLifecycleError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmptyString(value: unknown, field: string, issues: ExperimentValidationIssue[], maximum = 20_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    issues.push({ field, message: `must be a non-empty string of at most ${maximum} characters` });
  }
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown, field: string, issues: ExperimentValidationIssue[], maximum: number): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    issues.push({ field, message: "must be an array of strings" });
    return [];
  }
  const result = value.map((item) => item.trim());
  if (result.some((item) => !item || item.length > maximum)) issues.push({ field, message: `entries must be 1-${maximum} characters` });
  if (new Set(result).size !== result.length) issues.push({ field, message: "must not contain duplicates" });
  return result;
}

const kindPattern = /^[A-Za-z][A-Za-z0-9]*$/;
const resourceNamePattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

function isValidResourceName(value: string): boolean {
  return value.length <= 253 && value.split(".").every((part) => part.length <= 63) && resourceNamePattern.test(value);
}

function workloads(value: unknown, issues: ExperimentValidationIssue[]): ExperimentWorkload[] {
  if (!Array.isArray(value)) {
    issues.push({ field: "workloads", message: "must be an array" });
    return [];
  }
  const result: ExperimentWorkload[] = [];
  for (const item of value) {
    const source = typeof item === "string"
      ? (() => {
        const parts = item.split("|").map((part) => part.trim());
        if (parts.length !== 4) return null;
        const [clusterId, namespace, kind, name] = parts;
        return { clusterId, namespace, kind, name };
      })()
      : record(item);
    const clusterId = typeof source?.clusterId === "string" ? source.clusterId.trim() : "";
    const namespace = typeof source?.namespace === "string" ? source.namespace.trim() : "";
    const kind = typeof source?.kind === "string" ? source.kind.trim() : "";
    const name = typeof source?.name === "string" ? source.name.trim() : "";
    if (!isValidClusterId(clusterId) || !isValidNamespace(namespace) || !kindPattern.test(kind) || kind.length > 63 || !isValidResourceName(name)) {
      issues.push({ field: "workloads", message: "each workload requires valid Kubernetes clusterId, namespace, kind, and name identifiers" });
      continue;
    }
    result.push({ clusterId, namespace, kind, name });
  }
  const keys = result.map((item) => `${item.clusterId}\u0000${item.namespace}\u0000${item.kind}\u0000${item.name}`);
  if (new Set(keys).size !== keys.length) issues.push({ field: "workloads", message: "must not contain duplicates" });
  return result;
}

function state(value: unknown, issues: ExperimentValidationIssue[]): ExperimentState {
  if (typeof value !== "string" || !(EXPERIMENT_STATES as readonly string[]).includes(value)) {
    issues.push({ field: "state", message: `must be one of ${EXPERIMENT_STATES.join(", ")}` });
    return "draft";
  }
  return value as ExperimentState;
}

function gitRevision(value: unknown, issues: ExperimentValidationIssue[]): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > 256 || !/^[A-Za-z0-9._/-]+$/.test(value.trim())) {
    issues.push({ field: "gitRevision", message: "must be an optional revision identifier" });
    return null;
  }
  return value.trim();
}

function validate(value: Record<string, unknown>): ExperimentInput {
  const issues: ExperimentValidationIssue[] = [];
  const hypothesis = nonEmptyString(value.hypothesis, "hypothesis", issues);
  const change = nonEmptyString(value.change, "change", issues);
  const observation = nonEmptyString(value.observation, "observation", issues);
  const conclusion = typeof value.conclusion === "string" && value.conclusion.length <= 20_000 ? value.conclusion : "";
  if (typeof value.conclusion !== "string" || value.conclusion.length > 20_000) issues.push({ field: "conclusion", message: "must be a string of at most 20000 characters" });
  const lifecycle = state(value.state ?? value.lifecycleState ?? "draft", issues);
  if (lifecycle === "concluded" && !conclusion.trim()) issues.push({ field: "conclusion", message: "is required for a concluded Experiment" });
  const tags = stringList(value.tags ?? [], "tags", issues, 64);
  const associatedWorkloads = workloads(value.workloads ?? value.associatedWorkloads ?? [], issues);
  const revision = gitRevision(value.gitRevision, issues);
  if (issues.length > 0) throw new ExperimentValidationError(issues);
  return { hypothesis, change, observation, conclusion, state: lifecycle, tags, workloads: associatedWorkloads, gitRevision: revision };
}

export function validateExperimentInput(input: unknown): Readonly<{ valid: true; value: ExperimentInput } | { valid: false; issues: readonly ExperimentValidationIssue[] }> {
  const value = record(input);
  if (!value) return { valid: false, issues: [{ field: "experiment", message: "must be an object" }] };
  try {
    return { valid: true, value: validate(value) };
  } catch (error) {
    if (error instanceof ExperimentValidationError) return { valid: false, issues: error.issues };
    throw error;
  }
}

export function parseExperimentInput(input: unknown): ExperimentInput {
  const result = validateExperimentInput(input);
  if (!result.valid) throw new ExperimentValidationError(result.issues);
  return result.value;
}

const transitions: Readonly<Record<ExperimentState, readonly ExperimentState[]>> = {
  draft: ["draft", "active", "abandoned"],
  active: ["active", "concluded", "abandoned"],
  concluded: ["concluded"],
  abandoned: ["abandoned"],
};

export function isValidExperimentTransition(from: ExperimentState, to: ExperimentState): boolean {
  return transitions[from].includes(to);
}

export function createExperimentRecord(
  workspaceId: string,
  createdByMemberId: string,
  timelineEntryId: string,
  input: unknown,
  now = new Date().toISOString(),
): ExperimentRecord {
  const value = parseExperimentInput(input);
  return {
    id: randomUUID(),
    workspaceId,
    timelineEntryId,
    createdByMemberId,
    ...value,
    tags: [...value.tags],
    workloads: value.workloads.map((workload) => ({ ...workload })),
    createdAt: now,
    updatedAt: now,
  };
}

export function updateExperimentRecord(current: ExperimentRecord, input: unknown, now = new Date().toISOString()): ExperimentRecord {
  const source = record(input);
  if (!source) throw new ExperimentValidationError([{ field: "experiment", message: "must be an object" }]);
  const merged: Record<string, unknown> = {
    hypothesis: current.hypothesis,
    change: current.change,
    observation: current.observation,
    conclusion: current.conclusion,
    state: current.state,
    tags: current.tags,
    workloads: current.workloads,
    gitRevision: current.gitRevision,
    ...source,
  };
  const value = parseExperimentInput(merged);
  if (!isValidExperimentTransition(current.state, value.state)) throw new ExperimentLifecycleError(current.state, value.state);
  return {
    ...current,
    ...value,
    tags: [...value.tags],
    workloads: value.workloads.map((workload) => ({ ...workload })),
    updatedAt: now,
  };
}

export function requireExperimentWrite(member: Pick<MemberRecord, "capabilities">): void {
  requireCapability(member, capabilities.experimentWrite);
}

export interface ExperimentStore {
  createExperiment(workspaceId: string, createdByMemberId: string, input: unknown): Promise<ExperimentRecord>;
  updateExperiment(workspaceId: string, id: string, input: unknown): Promise<ExperimentRecord | null>;
  getExperiment(workspaceId: string, id: string): Promise<ExperimentRecord | null>;
  listExperiments(workspaceId: string): Promise<readonly ExperimentRecord[]>;
}

export async function createExperiment(
  member: Pick<MemberRecord, "id" | "workspaceId" | "capabilities">,
  store: ExperimentStore,
  input: unknown,
): Promise<ExperimentRecord> {
  requireExperimentWrite(member);
  return store.createExperiment(member.workspaceId, member.id, input);
}

export async function updateExperiment(
  member: Pick<MemberRecord, "workspaceId" | "capabilities">,
  store: ExperimentStore,
  id: string,
  input: unknown,
): Promise<ExperimentRecord | null> {
  requireExperimentWrite(member);
  return store.updateExperiment(member.workspaceId, id, input);
}

export function hasExperimentWrite(member: Pick<MemberRecord, "capabilities">): boolean {
  return member.capabilities.includes(capabilities.experimentWrite);
}

export const CORRELATION_SIGNALS = ["time", "ownership", "label", "revision"] as const;
export type CorrelationSignal = (typeof CORRELATION_SIGNALS)[number];
export const CORRELATION_SUGGESTION_STATUSES = ["pending", "confirmed", "rejected"] as const;
export type CorrelationSuggestionStatus = (typeof CORRELATION_SUGGESTION_STATUSES)[number];
export type CorrelationDecision = "confirm" | "reject";

export const CORRELATION_TIME_WINDOW_MS = 24 * 60 * 60 * 1000;

type CorrelationOwner = Readonly<{ kind: string; name: string; uid: string | null }>;
type CorrelationObservation = Readonly<{
  kind: string;
  name: string;
  namespace: string;
  clusterId: string;
  sourceIdentity: string;
  ownerReferences: readonly CorrelationOwner[];
  labels: Readonly<Record<string, string>>;
  revision: string | null;
}>;
type CorrelationWorkload = Readonly<{
  clusterId: string;
  namespace: string;
  kind: string;
  name: string;
}>;
export type CorrelationEntry = Readonly<{
  id: string;
  workspaceId: string;
  occurredAt: string;
  clusterId: string | null;
  observation?: CorrelationObservation;
  experiment?: Readonly<{ workloads: readonly CorrelationWorkload[]; gitRevision: string | null }>;
}>;

export type CorrelationSuggestionRecord = Readonly<{
  id: string;
  workspaceId: string;
  leftEntryId: string;
  rightEntryId: string;
  signals: readonly CorrelationSignal[];
  status: CorrelationSuggestionStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedByMemberId: string | null;
  confirmedLink?: ConfirmedLinkRecord;
}>;
export type CorrelationSuggestion = CorrelationSuggestionRecord;

export type CorrelationDecisionResult = Readonly<{
  suggestion: CorrelationSuggestionRecord;
  confirmedLink: ConfirmedLinkRecord | null;
  idempotent: boolean;
}>;

function correlationObservation(entry: CorrelationEntry): CorrelationObservation | null {
  return entry.observation ?? null;
}

function correlationExperiment(entry: CorrelationEntry): Readonly<{ workloads: readonly CorrelationWorkload[]; gitRevision: string | null }> | null {
  return entry.experiment ?? null;
}

function workloadMatchesObservation(workload: CorrelationWorkload, observation: CorrelationObservation): boolean {
  if (workload.clusterId !== observation.clusterId || workload.namespace !== observation.namespace) return false;
  if (workload.kind === observation.kind && workload.name === observation.name) return true;
  return observation.ownerReferences.some((owner) => owner.kind === workload.kind && owner.name === workload.name);
}

function observationUid(observation: CorrelationObservation): string {
  const separator = observation.sourceIdentity.indexOf(":");
  return separator < 0 ? observation.sourceIdentity : observation.sourceIdentity.slice(separator + 1);
}

function ownershipSignal(left: CorrelationEntry, right: CorrelationEntry): boolean {
  const leftObservation = correlationObservation(left);
  const rightObservation = correlationObservation(right);
  if (leftObservation && rightObservation) {
    return leftObservation.clusterId === rightObservation.clusterId
      && (leftObservation.ownerReferences.some((owner) => owner.uid === observationUid(rightObservation) || (owner.kind === rightObservation.kind && owner.name === rightObservation.name))
        || rightObservation.ownerReferences.some((owner) => owner.uid === observationUid(leftObservation) || (owner.kind === leftObservation.kind && owner.name === leftObservation.name)));
  }
  const leftExperiment = correlationExperiment(left);
  const rightExperiment = correlationExperiment(right);
  if (leftExperiment && rightObservation) return leftExperiment.workloads.some((workload) => workloadMatchesObservation(workload, rightObservation));
  if (rightExperiment && leftObservation) return rightExperiment.workloads.some((workload) => workloadMatchesObservation(workload, leftObservation));
  if (leftExperiment && rightExperiment) {
    return leftExperiment.workloads.some((leftWorkload) => rightExperiment.workloads.some((rightWorkload) =>
      leftWorkload.clusterId === rightWorkload.clusterId && leftWorkload.namespace === rightWorkload.namespace
        && leftWorkload.kind === rightWorkload.kind && leftWorkload.name === rightWorkload.name));
  }
  return false;
}

function labelSignal(left: CorrelationEntry, right: CorrelationEntry): boolean {
  const leftObservation = correlationObservation(left);
  const rightObservation = correlationObservation(right);
  if (!leftObservation || !rightObservation) return false;
  return Object.entries(leftObservation.labels).some(([key, value]) => rightObservation.labels[key] === value);
}

function revisionSignal(left: CorrelationEntry, right: CorrelationEntry): boolean {
  const leftObservation = correlationObservation(left);
  const rightObservation = correlationObservation(right);
  const leftExperiment = correlationExperiment(left);
  const rightExperiment = correlationExperiment(right);
  const revisions = [
    leftObservation?.revision,
    rightObservation?.revision,
    leftExperiment?.gitRevision,
    rightExperiment?.gitRevision,
  ].filter((revision): revision is string => Boolean(revision));
  return new Set(revisions).size < revisions.length;
}

export function correlationSignalsBetween(left: CorrelationEntry, right: CorrelationEntry): readonly CorrelationSignal[] {
  if (left.id === right.id || left.workspaceId !== right.workspaceId) return [];
  const signals: CorrelationSignal[] = [];
  const leftTime = Date.parse(left.occurredAt);
  const rightTime = Date.parse(right.occurredAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && Math.abs(leftTime - rightTime) <= CORRELATION_TIME_WINDOW_MS) signals.push("time");
  if (ownershipSignal(left, right)) signals.push("ownership");
  if (labelSignal(left, right)) signals.push("label");
  if (revisionSignal(left, right)) signals.push("revision");
  return signals;
}

export function suggestCorrelationCandidates(entries: readonly CorrelationEntry[], now = new Date().toISOString()): readonly CorrelationSuggestionRecord[] {
  // ponytail: O(n²) scan is sufficient for the MVP; add indexed signal joins if Timeline volume requires it.
  const candidates: CorrelationSuggestionRecord[] = [];
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    const left = entries[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const right = entries[rightIndex];
      if (!right) continue;
      const signals = correlationSignalsBetween(left, right);
      if (signals.length === 0) continue;
      const leftEntryId = left.id < right.id ? left.id : right.id;
      const rightEntryId = left.id < right.id ? right.id : left.id;
      candidates.push({
        id: randomUUID(),
        workspaceId: left.workspaceId,
        leftEntryId,
        rightEntryId,
        signals,
        status: "pending",
        createdAt: now,
        decidedAt: null,
        decidedByMemberId: null,
      });
    }
  }
  return candidates;
}

export function requireCorrelationReview(member: Pick<MemberRecord, "capabilities">): void {
  requireCapability(member, capabilities.correlationReview);
}

export function hasCorrelationReview(member: Pick<MemberRecord, "capabilities">): boolean {
  return member.capabilities.includes(capabilities.correlationReview);
}

export interface CorrelationDecisionStore {
  decideCorrelationSuggestion(workspaceId: string, id: string, memberId: string, decision: CorrelationDecision): Promise<CorrelationDecisionResult | null>;
}

export async function confirmCorrelationSuggestion(
  member: Pick<MemberRecord, "id" | "workspaceId" | "capabilities">,
  store: CorrelationDecisionStore,
  id: string,
): Promise<CorrelationDecisionResult | null> {
  requireCorrelationReview(member);
  return store.decideCorrelationSuggestion(member.workspaceId, id, member.id, "confirm");
}

export async function rejectCorrelationSuggestion(
  member: Pick<MemberRecord, "id" | "workspaceId" | "capabilities">,
  store: CorrelationDecisionStore,
  id: string,
): Promise<CorrelationDecisionResult | null> {
  requireCorrelationReview(member);
  return store.decideCorrelationSuggestion(member.workspaceId, id, member.id, "reject");
}

export const DEFAULT_RETENTION_DAYS = 90;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

export type RetentionPolicy = Readonly<{
  workspaceId: string;
  retentionDays: number;
  updatedAt: string;
}>;

export type RetentionCleanupResult = Readonly<{
  workspaceId: string;
  retentionDays: number;
  cutoff: string;
  eligibleObservations: number;
  protectedObservations: number;
  deletedObservations: number;
  deletedTimelineEntries: number;
  failures: number;
  failureCount: number;
  retryable: boolean;
}>;

export type RetentionValidationIssue = Readonly<{ field: string; message: string }>;

export class RetentionValidationError extends Error {
  constructor(readonly issues: readonly RetentionValidationIssue[]) {
    super("Invalid Observation retention policy");
    this.name = "RetentionValidationError";
  }
}

export function parseRetentionDays(value: unknown): number {
  const input = record(value);
  const selected: unknown = input ? input.retentionDays ?? input.days : value;
  const days = typeof selected === "number"
    ? selected
    : typeof selected === "string" && /^\d+$/.test(selected.trim())
      ? Number(selected.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    throw new RetentionValidationError([{
      field: "retentionDays",
      message: `must be an integer from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}`,
    }]);
  }
  return days;
}

export function requireRetentionManagement(member: Pick<MemberRecord, "capabilities">): void {
  requireCapability(member, capabilities.retentionManage);
}

export function hasRetentionManagement(member: Pick<MemberRecord, "capabilities">): boolean {
  return member.capabilities.includes(capabilities.retentionManage);
}

export interface RetentionStore {
  getRetentionPolicy(workspaceId: string): Promise<RetentionPolicy>;
  updateRetentionPolicy(workspaceId: string, retentionDays: unknown): Promise<RetentionPolicy>;
  cleanupRetention(workspaceId: string, now?: Date | string): Promise<RetentionCleanupResult>;
}

export async function updateRetentionPolicy(
  member: Pick<MemberRecord, "workspaceId" | "capabilities">,
  store: RetentionStore,
  retentionDays: unknown,
): Promise<RetentionPolicy> {
  requireRetentionManagement(member);
  return store.updateRetentionPolicy(member.workspaceId, retentionDays);
}

export async function runRetentionCleanup(
  member: Pick<MemberRecord, "workspaceId" | "capabilities">,
  store: RetentionStore,
  now?: Date | string,
): Promise<RetentionCleanupResult> {
  requireRetentionManagement(member);
  return store.cleanupRetention(member.workspaceId, now);
}
