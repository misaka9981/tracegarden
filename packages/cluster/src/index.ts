import { randomUUID } from "node:crypto";
import {
  capabilities,
  requireCapability,
  type MemberRecord,
} from "../../identity/src/index.js";

export const SUPPORTED_RESOURCE_KINDS = [
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "Pod",
  "Job",
  "CronJob",
  "Event",
] as const;

export type SupportedResourceKind = (typeof SUPPORTED_RESOURCE_KINDS)[number];
export type WorkloadResourceKind = Exclude<SupportedResourceKind, "Event">;
export type ObservationClassification = "change" | "attention" | "recovery";
export type AttentionReasonCode =
  | "condition_failed"
  | "pod_not_ready"
  | "deployment_replicas_unavailable"
  | "statefulset_replicas_not_ready"
  | "daemonset_nodes_not_ready"
  | "replicaset_replicas_not_ready"
  | "job_failed"
  | "cronjob_suspended"
  | "event_warning";

export type ClusterScope = Readonly<{
  workspaceId: string;
  clusterId: string;
  name: string;
  endpoint: string;
  namespaces: readonly string[];
  resourceKinds: readonly SupportedResourceKind[];
}>;

export type ClusterScopeInput = Readonly<{
  clusterId?: string;
  name: string;
  endpoint: string;
  namespaces: readonly string[];
  resourceKinds: readonly string[];
}>;

export type ValidationIssue = Readonly<{
  field: string;
  message: string;
}>;

type ValidatedInput = Readonly<{
  clusterId?: string;
  name: string;
  endpoint: string;
  namespaces: readonly string[];
  resourceKinds: readonly SupportedResourceKind[];
}>;

export type ClusterScopeValidation =
  | Readonly<{ valid: true; value: ValidatedInput }>
  | Readonly<{ valid: false; issues: readonly ValidationIssue[] }>;

const namespacePattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const clusterIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function strings(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function stringList(value: unknown, field: string, issues: ValidationIssue[]): string[] | null {
  if (!strings(value) || value.some((item) => typeof item !== "string")) {
    issues.push({ field, message: "must be an array of strings" });
    return null;
  }
  return value.map((item) => (item as string).trim());
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function isSupportedResourceKind(value: string): value is SupportedResourceKind {
  return (SUPPORTED_RESOURCE_KINDS as readonly string[]).includes(value);
}

export function isValidNamespace(value: string): boolean {
  return value.length <= 63 && namespacePattern.test(value);
}

export function validateClusterScopeInput(input: unknown): ClusterScopeValidation {
  const value = record(input);
  if (!value) return { valid: false, issues: [{ field: "scope", message: "must be an object" }] };

  const issues: ValidationIssue[] = [];
  const rawId = value.clusterId;
  const clusterId = rawId === undefined ? undefined : typeof rawId === "string" ? rawId.trim() : "";
  if (rawId !== undefined && (!clusterId || !clusterIdPattern.test(clusterId))) {
    issues.push({ field: "clusterId", message: "must be 1-128 letters, numbers, dots, underscores, or hyphens" });
  }

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > 100) issues.push({ field: "name", message: "must be between 1 and 100 characters" });

  const endpoint = typeof value.endpoint === "string" ? value.endpoint.trim() : "";
  if (!endpoint) {
    issues.push({ field: "endpoint", message: "is required" });
  } else {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
      if (url.username || url.password) throw new Error("credentials are not allowed");
    } catch {
      issues.push({ field: "endpoint", message: "must be an absolute HTTP(S) URL without credentials" });
    }
  }

  const namespaces = stringList(value.namespaces, "namespaces", issues);
  if (namespaces) {
    if (!unique(namespaces)) issues.push({ field: "namespaces", message: "must not contain duplicates" });
    namespaces.forEach((namespace) => {
      if (!isValidNamespace(namespace)) issues.push({ field: "namespaces", message: `invalid namespace: ${namespace}` });
    });
  }

  const resourceKinds = stringList(value.resourceKinds, "resourceKinds", issues);
  if (resourceKinds) {
    if (!unique(resourceKinds)) issues.push({ field: "resourceKinds", message: "must not contain duplicates" });
    resourceKinds.forEach((kind) => {
      if (!isSupportedResourceKind(kind)) issues.push({ field: "resourceKinds", message: `unsupported resource kind: ${kind}` });
    });
  }

  if (issues.length > 0 || !namespaces || !resourceKinds) return { valid: false, issues };
  const validated: ValidatedInput = {
    ...(clusterId === undefined ? {} : { clusterId }),
    name,
    endpoint,
    namespaces,
    resourceKinds: resourceKinds as SupportedResourceKind[],
  };
  return { valid: true, value: validated };
}

export function parseClusterScopeInput(input: unknown): ValidatedInput {
  const result = validateClusterScopeInput(input);
  if (!result.valid) throw new ClusterScopeValidationError(result.issues);
  return result.value;
}

export class ClusterScopeValidationError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super("Invalid Cluster observation scope");
    this.name = "ClusterScopeValidationError";
  }
}

export function scopeFromInput(
  workspaceId: string,
  input: ClusterScopeInput | unknown,
  existing?: ClusterScope | null,
): ClusterScope {
  const validated = parseClusterScopeInput(input);
  return {
    workspaceId,
    clusterId: existing?.clusterId ?? validated.clusterId ?? randomUUID(),
    name: validated.name,
    endpoint: validated.endpoint,
    namespaces: [...validated.namespaces],
    resourceKinds: [...validated.resourceKinds],
  };
}

export interface ClusterScopeStore {
  get(workspaceId: string): Promise<ClusterScope | null>;
  save(scope: ClusterScope): Promise<ClusterScope>;
}

export class MemoryClusterScopeStore implements ClusterScopeStore {
  private scope: ClusterScope | null = null;

  async get(workspaceId: string): Promise<ClusterScope | null> {
    return this.scope?.workspaceId === workspaceId ? this.scope : null;
  }

  async save(scope: ClusterScope): Promise<ClusterScope> {
    this.scope = {
      ...scope,
      namespaces: [...scope.namespaces],
      resourceKinds: [...scope.resourceKinds],
    };
    return this.scope;
  }
}

export async function configureClusterScope(
  member: Pick<MemberRecord, "capabilities" | "workspaceId">,
  store: ClusterScopeStore,
  input: unknown,
): Promise<ClusterScope> {
  requireCapability(member, capabilities.clusterConfigure);
  const existing = await store.get(member.workspaceId);
  return store.save(scopeFromInput(member.workspaceId, input, existing));
}

export type KubernetesResource = Readonly<{
  kind: string;
  metadata: Readonly<{
    name: string;
    namespace?: string | null;
    uid?: string | null;
    resourceVersion?: string | null;
    ownerReferences?: readonly unknown[];
    labels?: Readonly<Record<string, unknown>>;
    annotations?: Readonly<Record<string, unknown>>;
    generation?: number | null;
    [key: string]: unknown;
  }>;
  spec?: Readonly<Record<string, unknown>>;
  status?: Readonly<Record<string, unknown>>;
  involvedObject?: Readonly<Record<string, unknown>>;
  regarding?: Readonly<Record<string, unknown>>;
  series?: Readonly<Record<string, unknown>>;
  type?: string;
  reason?: string;
  message?: string;
  note?: string;
  count?: number;
  deprecatedCount?: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  deprecatedFirstTimestamp?: string;
  deprecatedLastTimestamp?: string;
  eventTime?: string;
  [key: string]: unknown;
}>;

export type NormalizedOwnerReference = Readonly<{
  kind: string;
  name: string;
  uid: string | null;
  controller: boolean;
}>;

type NormalizedBaseObservation = Readonly<{
  workspaceId: string;
  clusterId: string;
  sourceIdentity: string;
  sourceKey: string;
  uid: string;
  name: string;
  namespace: string;
  resourceVersion: string | null;
  classification: ObservationClassification;
  attention: boolean;
  attentionReason: AttentionReasonCode | null;
  recoveryOf: string | null;
  reason: string | null;
  message: string | null;
  ownerReferences: readonly NormalizedOwnerReference[];
  revision: string | null;
  labels: Readonly<Record<string, string>>;
  observedAt: string;
}>;

export type NormalizedDeploymentObservation = NormalizedBaseObservation & Readonly<{
  kind: "Deployment";
  desiredReplicas: number | null;
  availableReplicas: number | null;
  readyReplicas: number | null;
  updatedReplicas: number | null;
  unavailableReplicas: number | null;
}>;

export type NormalizedStatefulSetObservation = NormalizedBaseObservation & Readonly<{
  kind: "StatefulSet";
  desiredReplicas: number | null;
  readyReplicas: number | null;
  currentReplicas: number | null;
  updatedReplicas: number | null;
  currentRevision: string | null;
  updateRevision: string | null;
}>;

export type NormalizedDaemonSetObservation = NormalizedBaseObservation & Readonly<{
  kind: "DaemonSet";
  desiredReplicas: number | null;
  currentReplicas: number | null;
  readyReplicas: number | null;
  updatedReplicas: number | null;
  availableReplicas: number | null;
  unavailableReplicas: number | null;
}>;

export type NormalizedReplicaSetObservation = NormalizedBaseObservation & Readonly<{
  kind: "ReplicaSet";
  desiredReplicas: number | null;
  currentReplicas: number | null;
  readyReplicas: number | null;
  availableReplicas: number | null;
}>;

export type NormalizedPodObservation = NormalizedBaseObservation & Readonly<{
  kind: "Pod";
  phase: string | null;
  ready: boolean | null;
}>;

export type NormalizedJobObservation = NormalizedBaseObservation & Readonly<{
  kind: "Job";
  desiredCompletions: number | null;
  active: number | null;
  succeeded: number | null;
  failed: number | null;
  completionTime: string | null;
}>;

export type NormalizedCronJobObservation = NormalizedBaseObservation & Readonly<{
  kind: "CronJob";
  schedule: string | null;
  suspend: boolean | null;
  active: number | null;
  lastScheduleTime: string | null;
  lastSuccessfulTime: string | null;
}>;

export type NormalizedEventObservation = NormalizedBaseObservation & Readonly<{
  kind: "Event";
  eventType: string | null;
  count: number | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  involvedKind: string | null;
  involvedName: string | null;
  involvedNamespace: string | null;
  involvedUid: string | null;
}>;

export type NormalizedObservation =
  | NormalizedDeploymentObservation
  | NormalizedStatefulSetObservation
  | NormalizedDaemonSetObservation
  | NormalizedReplicaSetObservation
  | NormalizedPodObservation
  | NormalizedJobObservation
  | NormalizedCronJobObservation
  | NormalizedEventObservation;
export type Observation = NormalizedObservation;
export type PodObservation = NormalizedPodObservation;
export type NormalizedResourceObservation = NormalizedObservation;

export class ObservationNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservationNormalizationError";
  }
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function boundedString(value: unknown, limit: number): string | null {
  const normalized = optionalString(value);
  return normalized ? normalized.slice(0, limit) : null;
}

function numberValue(value: unknown): number | null {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function selectedLabels(value: unknown): Readonly<Record<string, string>> {
  const labels = objectValue(value);
  if (!labels) return {};
  const selected: Record<string, string> = {};
  const useful = new Set(["app", "component", "version", "app.kubernetes.io/name", "app.kubernetes.io/instance", "app.kubernetes.io/version", "pod-template-hash", "controller-revision-hash"]);
  for (const [key, raw] of Object.entries(labels)) {
    if (Object.keys(selected).length >= 32 || !useful.has(key)) continue;
    const valueString = optionalString(raw);
    if (valueString && valueString.length <= 256) selected[key] = valueString;
  }
  return selected;
}

function normalizedOwners(value: unknown): readonly NormalizedOwnerReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const owner = objectValue(item);
    const kind = optionalString(owner?.kind);
    const name = optionalString(owner?.name);
    if (!kind || !name) return [];
    return [{
      kind,
      name,
      uid: optionalString(owner?.uid),
      controller: owner?.controller === true,
    } satisfies NormalizedOwnerReference];
  }).slice(0, 16);
}

function revisionFor(resource: KubernetesResource, status: Record<string, unknown> | null, labels: Readonly<Record<string, string>>): string | null {
  const metadata = resource.metadata;
  const annotations = objectValue(metadata.annotations);
  const annotationRevision = optionalString(annotations?.["deployment.kubernetes.io/revision"]);
  const statusRevision = optionalString(status?.updateRevision) ?? optionalString(status?.currentRevision);
  return annotationRevision
    ?? statusRevision
    ?? labels["controller-revision-hash"]
    ?? labels["pod-template-hash"]
    ?? (typeof metadata.generation === "number" && Number.isSafeInteger(metadata.generation) && metadata.generation >= 0 ? String(metadata.generation) : null);
}

function conditions(resource: KubernetesResource): readonly Record<string, unknown>[] {
  return Array.isArray(resource.status?.conditions)
    ? resource.status.conditions.flatMap((item) => {
      const normalized = objectValue(item);
      return normalized ? [normalized] : [];
    })
    : [];
}

function condition(resource: KubernetesResource, type: string): Record<string, unknown> | null {
  return conditions(resource).find((item) => item.type === type) ?? null;
}

function abnormalCondition(kind: SupportedResourceKind, resource: KubernetesResource): Record<string, unknown> | null {
  const relevantTypes = new Set(["Failed", "Degraded", "Available", "Progressing"]);
  return conditions(resource).find((candidate) => {
    if (!relevantTypes.has(candidate.type as string)) return false;
    return candidate.status === "False"
      || candidate.status === "Unknown"
      || kind === "Job" && candidate.type === "Failed" && candidate.status === "True";
  }) ?? null;
}

function abnormalReason(kind: SupportedResourceKind, resource: KubernetesResource, status: Record<string, unknown> | null): AttentionReasonCode | null {
  if (kind === "Event") return optionalString(resource.type)?.toLowerCase() === "warning" ? "event_warning" : null;
  if (abnormalCondition(kind, resource)) {
    return "condition_failed";
  }
  if (kind === "Pod") {
    const ready = condition(resource, "Ready");
    const reason = optionalString(status?.reason) ?? optionalString(ready?.reason);
    const waitingReasons = new Set(["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError"]);
    if (waitingReasons.has(reason ?? "") || status?.phase === "Failed" || status?.phase === "Unknown" || ready?.status === "False") return "pod_not_ready";
  }
  if (kind === "Deployment") {
    const desired = numberValue(resource.spec?.replicas) ?? 1;
    const available = numberValue(status?.availableReplicas);
    const unavailable = numberValue(status?.unavailableReplicas);
    if (available !== null && available < desired || unavailable !== null && unavailable > 0) return "deployment_replicas_unavailable";
  }
  if (kind === "StatefulSet") {
    const desired = numberValue(resource.spec?.replicas) ?? 1;
    const ready = numberValue(status?.readyReplicas);
    if (ready !== null && ready < desired) return "statefulset_replicas_not_ready";
  }
  if (kind === "DaemonSet") {
    const desired = numberValue(status?.desiredNumberScheduled) ?? 0;
    if (desired > 0 && (numberValue(status?.numberReady) ?? 0) < desired) return "daemonset_nodes_not_ready";
  }
  if (kind === "ReplicaSet") {
    const desired = numberValue(resource.spec?.replicas) ?? 0;
    if (desired > 0 && (numberValue(status?.readyReplicas) ?? 0) < desired) return "replicaset_replicas_not_ready";
  }
  if (kind === "Job") {
    const desired = numberValue(resource.spec?.completions) ?? 1;
    const failed = numberValue(status?.failed) ?? 0;
    const succeeded = numberValue(status?.succeeded) ?? 0;
    if (failed > 0 && succeeded < desired) return "job_failed";
  }
  if (kind === "CronJob" && resource.spec?.suspend === true) return "cronjob_suspended";
  return null;
}

function eventObject(resource: KubernetesResource): Record<string, unknown> | null {
  return objectValue(resource.regarding) ?? objectValue(resource.involvedObject);
}

function involvedNamespace(resource: KubernetesResource): string | null {
  return optionalString(resource.metadata.namespace) ?? optionalString(eventObject(resource)?.namespace);
}

function baseObservation(
  scope: ClusterScope,
  resource: KubernetesResource,
  observedAt: string,
): NormalizedBaseObservation {
  if (!isSupportedResourceKind(resource.kind) || !isResourceInScope(scope, resource)) {
    throw new ObservationNormalizationError(`${resource.kind || "Resource"} is outside the approved observation scope`);
  }
  const name = optionalString(resource.metadata.name) ?? "";
  const namespace = involvedNamespace(resource) ?? "";
  const uid = optionalString(resource.metadata.uid) ?? "";
  if (!name || !namespace || !uid) throw new ObservationNormalizationError(`${resource.kind} observation requires name, namespace, and Kubernetes UID`);
  if (!Number.isFinite(Date.parse(observedAt))) throw new ObservationNormalizationError(`${resource.kind} observation timestamp is invalid`);
  const status = objectValue(resource.status);
  const labels = selectedLabels(resource.metadata.labels);
  const conditionFacts = abnormalCondition(resource.kind, resource)
    ?? condition(resource, "Failed")
    ?? condition(resource, "Degraded")
    ?? condition(resource, "Available")
    ?? condition(resource, "Progressing")
    ?? condition(resource, "Ready");
  const reason = resource.kind === "Event"
    ? boundedString(resource.reason, 256)
    : boundedString(status?.reason, 256) ?? boundedString(conditionFacts?.reason, 256);
  const message = resource.kind === "Event"
    ? boundedString(resource.note, 2048) ?? boundedString(resource.message, 2048)
    : boundedString(status?.message, 2048) ?? boundedString(conditionFacts?.message, 2048);
  const attentionReason = abnormalReason(resource.kind, resource, status);
  const resourceVersion = optionalString(resource.metadata.resourceVersion);
  return {
    workspaceId: scope.workspaceId,
    clusterId: scope.clusterId,
    sourceIdentity: `${scope.clusterId}:${uid}`,
    sourceKey: `${scope.clusterId}:${uid}:${resourceVersion ?? "snapshot"}`,
    uid,
    name,
    namespace,
    resourceVersion,
    classification: attentionReason ? "attention" : "change",
    attention: attentionReason !== null,
    attentionReason,
    recoveryOf: null,
    reason,
    message,
    ownerReferences: normalizedOwners(resource.metadata.ownerReferences),
    revision: revisionFor(resource, status, labels),
    labels,
    observedAt: new Date(observedAt).toISOString(),
  };
}

function statusNumber(resource: KubernetesResource, key: string): number | null {
  return numberValue(resource.status?.[key]);
}

function timestampValue(value: unknown): string | null {
  const normalized = optionalString(value);
  return normalized && Number.isFinite(Date.parse(normalized)) ? new Date(normalized).toISOString() : null;
}

export function normalizeObservation(
  scope: ClusterScope,
  resource: KubernetesResource,
  observedAt = new Date().toISOString(),
): NormalizedObservation {
  const base = baseObservation(scope, resource, observedAt);
  const status = objectValue(resource.status);
  switch (resource.kind) {
    case "Deployment":
      return {
        ...base,
        kind: "Deployment",
        desiredReplicas: numberValue(resource.spec?.replicas),
        availableReplicas: statusNumber(resource, "availableReplicas"),
        readyReplicas: statusNumber(resource, "readyReplicas"),
        updatedReplicas: statusNumber(resource, "updatedReplicas"),
        unavailableReplicas: statusNumber(resource, "unavailableReplicas"),
      };
    case "StatefulSet":
      return {
        ...base,
        kind: "StatefulSet",
        desiredReplicas: numberValue(resource.spec?.replicas),
        readyReplicas: statusNumber(resource, "readyReplicas"),
        currentReplicas: statusNumber(resource, "currentReplicas"),
        updatedReplicas: statusNumber(resource, "updatedReplicas"),
        currentRevision: optionalString(status?.currentRevision),
        updateRevision: optionalString(status?.updateRevision),
      };
    case "DaemonSet":
      return {
        ...base,
        kind: "DaemonSet",
        desiredReplicas: statusNumber(resource, "desiredNumberScheduled"),
        currentReplicas: statusNumber(resource, "currentNumberScheduled"),
        readyReplicas: statusNumber(resource, "numberReady"),
        updatedReplicas: statusNumber(resource, "updatedNumberScheduled"),
        availableReplicas: statusNumber(resource, "numberAvailable"),
        unavailableReplicas: statusNumber(resource, "numberUnavailable"),
      };
    case "ReplicaSet":
      return {
        ...base,
        kind: "ReplicaSet",
        desiredReplicas: numberValue(resource.spec?.replicas),
        currentReplicas: statusNumber(resource, "replicas"),
        readyReplicas: statusNumber(resource, "readyReplicas"),
        availableReplicas: statusNumber(resource, "availableReplicas"),
      };
    case "Pod": {
      const readyCondition = condition(resource, "Ready");
      const readyStatus = readyCondition?.status;
      return {
        ...base,
        kind: "Pod",
        phase: optionalString(status?.phase),
        ready: readyStatus === "True" ? true : readyStatus === "False" ? false : null,
        reason: optionalString(status?.reason) ?? optionalString(readyCondition?.reason),
      };
    }
    case "Job":
      return {
        ...base,
        kind: "Job",
        desiredCompletions: numberValue(resource.spec?.completions),
        active: statusNumber(resource, "active"),
        succeeded: statusNumber(resource, "succeeded"),
        failed: statusNumber(resource, "failed"),
        completionTime: timestampValue(status?.completionTime),
      };
    case "CronJob":
      return {
        ...base,
        kind: "CronJob",
        schedule: optionalString(resource.spec?.schedule),
        suspend: booleanValue(resource.spec?.suspend),
        active: Array.isArray(status?.active) ? status.active.length : statusNumber(resource, "active"),
        lastScheduleTime: timestampValue(status?.lastScheduleTime),
        lastSuccessfulTime: timestampValue(status?.lastSuccessfulTime),
      };
    case "Event": {
      const involved = eventObject(resource);
      const eventTime = timestampValue(resource.eventTime);
      const series = objectValue(resource.series);
      return {
        ...base,
        kind: "Event",
        eventType: optionalString(resource.type),
        count: numberValue(series?.count) ?? numberValue(resource.count) ?? numberValue(resource.deprecatedCount),
        firstTimestamp: timestampValue(resource.firstTimestamp) ?? timestampValue(resource.deprecatedFirstTimestamp) ?? eventTime,
        lastTimestamp: timestampValue(resource.lastTimestamp) ?? timestampValue(resource.deprecatedLastTimestamp) ?? timestampValue(series?.lastObservedTime) ?? eventTime,
        involvedKind: optionalString(involved?.kind),
        involvedName: optionalString(involved?.name),
        involvedNamespace: optionalString(involved?.namespace),
        involvedUid: optionalString(involved?.uid),
      };
    }
    default:
      throw new ObservationNormalizationError(`${resource.kind} is not supported`);
  }
}

export const normalizeKubernetesObservation = normalizeObservation;
export const normalizeResourceObservation = normalizeObservation;

type ObservationForKind<K extends SupportedResourceKind> = Extract<NormalizedObservation, { kind: K }>;

function normalizeKind<K extends SupportedResourceKind>(
  scope: ClusterScope,
  resource: KubernetesResource,
  kind: K,
  observedAt?: string,
): ObservationForKind<K> {
  const observation = normalizeObservation(scope, resource, observedAt);
  if (observation.kind !== kind) throw new ObservationNormalizationError(`Expected a ${kind} observation`);
  return observation as ObservationForKind<K>;
}

export const normalizeDeploymentObservation = (scope: ClusterScope, resource: KubernetesResource, observedAt?: string): NormalizedDeploymentObservation => normalizeKind(scope, resource, "Deployment", observedAt);
export const normalizeStatefulSetObservation = (scope: ClusterScope, resource: KubernetesResource, observedAt?: string): NormalizedStatefulSetObservation => normalizeKind(scope, resource, "StatefulSet", observedAt);
export const normalizeDaemonSetObservation = (scope: ClusterScope, resource: KubernetesResource, observedAt?: string): NormalizedDaemonSetObservation => normalizeKind(scope, resource, "DaemonSet", observedAt);
export const normalizeReplicaSetObservation = (scope: ClusterScope, resource: KubernetesResource, observedAt?: string): NormalizedReplicaSetObservation => normalizeKind(scope, resource, "ReplicaSet", observedAt);
export const normalizeJobObservation = (scope: ClusterScope, resource: KubernetesResource, observedAt?: string): NormalizedJobObservation => normalizeKind(scope, resource, "Job", observedAt);
export const normalizeCronJobObservation = (scope: ClusterScope, resource: KubernetesResource, observedAt?: string): NormalizedCronJobObservation => normalizeKind(scope, resource, "CronJob", observedAt);
export const normalizeEventObservation = (scope: ClusterScope, resource: KubernetesResource, observedAt?: string): NormalizedEventObservation => normalizeKind(scope, resource, "Event", observedAt);

export function normalizePodObservation(
  scope: ClusterScope,
  resource: KubernetesResource,
  observedAt = new Date().toISOString(),
): NormalizedPodObservation {
  const normalized = normalizeObservation(scope, resource, observedAt);
  if (normalized.kind !== "Pod") throw new ObservationNormalizationError("Expected a Pod observation");
  return normalized;
}

export function isResourceInScope(scope: ClusterScope, resource: KubernetesResource): boolean {
  const metadata = objectValue(resource.metadata);
  const namespace = optionalString(metadata?.namespace) ?? optionalString(eventObject(resource)?.namespace);
  return isSupportedResourceKind(resource.kind)
    && scope.resourceKinds.includes(resource.kind)
    && namespace !== null
    && scope.namespaces.includes(namespace);
}

export function isAttentionObservation(observation: Pick<NormalizedObservation, "attention">): boolean {
  return observation.attention;
}

export function isRecoveryObservation(observation: Pick<NormalizedObservation, "classification">): boolean {
  return observation.classification === "recovery";
}

export function markRecovery(
  observation: NormalizedObservation,
  previous: Pick<NormalizedObservation, "attention" | "sourceKey"> | null,
): NormalizedObservation {
  if (!previous || !previous.attention || observation.attention) return observation;
  return { ...observation, classification: "recovery", recoveryOf: previous.sourceKey };
}

export interface KubernetesObservationAdapter {
  readonly kind: "deterministic" | "inert" | "production";
  readonly contacted: boolean;
  list(scope: ClusterScope): Promise<readonly KubernetesResource[]>;
}

export class DeterministicKubernetesAdapter implements KubernetesObservationAdapter {
  readonly kind = "deterministic" as const;
  readonly contacted = false;
  readonly requests: ClusterScope[] = [];

  constructor(private readonly resources: readonly KubernetesResource[]) {}

  async list(scope: ClusterScope): Promise<readonly KubernetesResource[]> {
    this.requests.push(scope);
    return this.resources.filter((resource) => isResourceInScope(scope, resource));
  }
}

export class InertKubernetesAdapter implements KubernetesObservationAdapter {
  readonly kind = "inert" as const;
  readonly contacted = false;

  async list(): Promise<readonly KubernetesResource[]> {
    return [];
  }
}

export type KubernetesAdapterConfiguration = Readonly<{
  endpoint: string;
  token: string;
}>;

export function productionKubernetesConfiguration(
  environment: Record<string, string | undefined>,
): KubernetesAdapterConfiguration | null {
  const endpoint = (environment.KUBERNETES_API_SERVER ?? environment.TRACEGARDEN_KUBERNETES_API_SERVER)?.trim();
  const token = (environment.KUBERNETES_OBSERVATION_TOKEN ?? environment.TRACEGARDEN_KUBERNETES_TOKEN)?.trim();
  if (!endpoint || !token) return null;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { endpoint, token };
}

function projectedMap(value: unknown): Readonly<Record<string, string>> | undefined {
  const source = objectValue(value);
  if (!source) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(source).slice(0, 64)) {
    const normalized = optionalString(item);
    if (normalized && normalized.length <= 256) result[key] = normalized;
  }
  return result;
}

function projectedOwners(value: unknown): readonly Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const owner = objectValue(item);
    const kind = optionalString(owner?.kind);
    const name = optionalString(owner?.name);
    if (!kind || !name) return [];
    return [{
      kind,
      name,
      ...(optionalString(owner?.uid) ? { uid: optionalString(owner?.uid) } : {}),
      ...(owner?.controller === true ? { controller: true } : {}),
    }];
  }).slice(0, 16);
}

function projectedReference(value: unknown): Readonly<Record<string, string>> | undefined {
  const reference = objectValue(value);
  if (!reference) return undefined;
  const projected: Record<string, string> = {};
  for (const key of ["apiVersion", "kind", "name", "namespace", "uid", "resourceVersion", "fieldPath"]) {
    const normalized = optionalString(reference[key]);
    if (normalized) projected[key] = normalized;
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectedStatus(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const status = objectValue(value);
  if (!status) return undefined;
  const keys = [
    "phase", "reason", "message", "replicas", "readyReplicas", "availableReplicas", "updatedReplicas", "unavailableReplicas",
    "currentReplicas", "currentRevision", "updateRevision", "desiredNumberScheduled", "currentNumberScheduled",
    "numberReady", "updatedNumberScheduled", "numberAvailable", "numberUnavailable", "active", "succeeded", "failed",
    "completionTime", "lastScheduleTime", "lastSuccessfulTime",
  ];
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    const valueForKey = status[key];
    if (Array.isArray(valueForKey) && key === "active") projected[key] = valueForKey.length;
    else if (typeof valueForKey === "string") {
      const stringValue = boundedString(valueForKey, 2048);
      if (stringValue) projected[key] = stringValue;
    } else if (typeof valueForKey === "number") projected[key] = valueForKey;
  }
  const conditions = Array.isArray(status.conditions)
    ? status.conditions.flatMap((item) => {
      const source = objectValue(item);
      if (!source) return [];
      const type = optionalString(source.type);
      const conditionStatus = optionalString(source.status);
      if (!type || !conditionStatus) return [];
      return [{
        type,
        status: conditionStatus,
        ...(boundedString(source.reason, 256) ? { reason: boundedString(source.reason, 256) } : {}),
        ...(boundedString(source.message, 2048) ? { message: boundedString(source.message, 2048) } : {}),
      }];
    }).slice(0, 32)
    : [];
  if (conditions.length > 0) projected.conditions = conditions;
  return projected;
}

function projectedSpec(value: unknown, kind: SupportedResourceKind): Readonly<Record<string, unknown>> | undefined {
  const spec = objectValue(value);
  if (!spec) return undefined;
  const projected: Record<string, unknown> = {};
  if (["Deployment", "StatefulSet", "ReplicaSet", "Job"].includes(kind)) {
    const replicas = numberValue(spec.replicas);
    const completions = numberValue(spec.completions);
    if (replicas !== null) projected.replicas = replicas;
    if (completions !== null) projected.completions = completions;
  }
  if (kind === "CronJob") {
    const schedule = optionalString(spec.schedule);
    if (schedule) projected.schedule = schedule;
    if (typeof spec.suspend === "boolean") projected.suspend = spec.suspend;
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectResourceResponse(value: unknown, namespace: string, kind: SupportedResourceKind): KubernetesResource {
  const item = objectValue(value);
  const metadata = objectValue(item?.metadata);
  const name = optionalString(metadata?.name);
  const uid = optionalString(metadata?.uid);
  if (!name || !uid) throw new Error(`Kubernetes ${kind} list returned an item without identity`);
  const eventReference = objectValue(item?.regarding) ?? objectValue(item?.involvedObject);
  const itemNamespace = optionalString(metadata?.namespace) ?? optionalString(eventReference?.namespace) ?? namespace;
  const resourceVersion = optionalString(metadata?.resourceVersion);
  const labels = projectedMap(metadata?.labels);
  const annotations = projectedMap(metadata?.annotations);
  const ownerReferences = projectedOwners(metadata?.ownerReferences);
  const projectedMetadata = {
    name,
    namespace: itemNamespace,
    uid,
    ...(resourceVersion ? { resourceVersion } : {}),
    ...(typeof metadata?.generation === "number" && Number.isSafeInteger(metadata.generation) && metadata.generation >= 0 ? { generation: metadata.generation } : {}),
    ...(labels ? { labels } : {}),
    ...(annotations ? { annotations } : {}),
    ...(ownerReferences ? { ownerReferences } : {}),
  };
  const regarding = kind === "Event" ? projectedReference(item?.regarding) : undefined;
  const involvedObject = kind === "Event" ? projectedReference(item?.involvedObject) : undefined;
  const rawSeries = kind === "Event" ? objectValue(item?.series) : null;
  const seriesCount = numberValue(rawSeries?.count);
  const seriesLastObservedTime = optionalString(rawSeries?.lastObservedTime);
  const eventFields: Record<string, unknown> = kind === "Event"
    ? {
      ...(regarding ? { regarding } : {}),
      ...(involvedObject ? { involvedObject } : {}),
      ...Object.fromEntries(["type", "reason", "message", "note", "firstTimestamp", "lastTimestamp", "deprecatedFirstTimestamp", "deprecatedLastTimestamp", "eventTime"].flatMap((key) => {
        const stringValue = optionalString(item?.[key]);
        return stringValue ? [[key, stringValue]] : [];
      })),
      ...(seriesCount !== null || seriesLastObservedTime ? {
        series: {
          ...(seriesCount !== null ? { count: seriesCount } : {}),
          ...(seriesLastObservedTime ? { lastObservedTime: seriesLastObservedTime } : {}),
        },
      } : {}),
      ...(numberValue(item?.count) !== null ? { count: numberValue(item?.count) } : {}),
      ...(numberValue(item?.deprecatedCount) !== null ? { deprecatedCount: numberValue(item?.deprecatedCount) } : {}),
    }
    : {};
  const spec = projectedSpec(item?.spec, kind);
  const status = projectedStatus(item?.status);
  return {
    kind,
    metadata: projectedMetadata,
    ...(spec ? { spec } : {}),
    ...(status ? { status } : {}),
    ...eventFields,
  };
}

export class ConfiguredKubernetesAdapter implements KubernetesObservationAdapter {
  readonly kind = "production" as const;
  contacted = false;

  constructor(readonly configuration: KubernetesAdapterConfiguration) {}

  private endpointForScope(scope: ClusterScope, kind: SupportedResourceKind): URL {
    const configuredEndpoint = new URL(this.configuration.endpoint);
    const scopeEndpoint = new URL(scope.endpoint);
    if (configuredEndpoint.protocol !== "https:" || scopeEndpoint.protocol !== "https:" || configuredEndpoint.origin !== scopeEndpoint.origin) {
      throw new Error("Kubernetes scope endpoint does not match the configured observation endpoint");
    }
    const basePath = scopeEndpoint.pathname.replace(/\/$/, "");
    const core = kind === "Pod";
    const group = kind === "Event" ? "events.k8s.io" : kind === "Deployment" || kind === "StatefulSet" || kind === "DaemonSet" || kind === "ReplicaSet" ? "apps" : "batch";
    const version = kind === "Event" ? "v1" : kind === "Pod" ? "v1" : "v1";
    return new URL(`${basePath}/${core ? "api" : "apis"}/${core ? version : `${group}/${version}`}`, scope.endpoint);
  }

  async list(scope: ClusterScope): Promise<readonly KubernetesResource[]> {
    const resources: KubernetesResource[] = [];
    for (const kind of SUPPORTED_RESOURCE_KINDS) {
      if (!scope.resourceKinds.includes(kind)) continue;
      const apiEndpoint = this.endpointForScope(scope, kind);
      for (const namespace of scope.namespaces) {
        const plural = `${kind.toLowerCase()}s`.replace("ingresss", "ingresses").replace("cronjobs", "cronjobs");
        const endpoint = new URL(`${apiEndpoint.pathname}/namespaces/${encodeURIComponent(namespace)}/${plural}`, apiEndpoint.origin);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
          this.contacted = true;
          const response = await fetch(endpoint, {
            headers: { authorization: `Bearer ${this.configuration.token}`, accept: "application/json" },
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Kubernetes ${kind} list failed with HTTP ${response.status}`);
          const body: unknown = await response.json();
          const items = objectValue(body)?.items;
          if (!Array.isArray(items)) throw new Error(`Kubernetes ${kind} list returned an invalid response`);
          resources.push(...items.map((item) => projectResourceResponse(item, namespace, kind)));
        } finally {
          clearTimeout(timeout);
        }
      }
    }
    return resources.filter((resource) => isResourceInScope(scope, resource));
  }
}

export function createKubernetesAdapter(
  environment: Record<string, string | undefined> = process.env,
): KubernetesObservationAdapter {
  const configuration = productionKubernetesConfiguration(environment);
  return configuration ? new ConfiguredKubernetesAdapter(configuration) : new InertKubernetesAdapter();
}

export async function collectScopedResources(
  scope: ClusterScope,
  adapter: KubernetesObservationAdapter,
): Promise<readonly KubernetesResource[]> {
  const resources = await adapter.list(scope);
  return resources.filter((resource) => isResourceInScope(scope, resource));
}

export function hasClusterConfigureCapability(member: Pick<MemberRecord, "capabilities">): boolean {
  return member.capabilities.includes(capabilities.clusterConfigure);
}
