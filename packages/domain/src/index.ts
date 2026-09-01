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
