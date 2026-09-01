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
    [key: string]: unknown;
  }>;
  status?: Readonly<Record<string, unknown>>;
  [key: string]: unknown;
}>;

export type NormalizedPodObservation = Readonly<{
  kind: "Pod";
  workspaceId: string;
  clusterId: string;
  sourceIdentity: string;
  sourceKey: string;
  uid: string;
  name: string;
  namespace: string;
  resourceVersion: string | null;
  phase: string | null;
  ready: boolean | null;
  reason: string | null;
  observedAt: string;
}>;

export type PodObservation = NormalizedPodObservation;
export type Observation = NormalizedPodObservation;

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

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

export function normalizePodObservation(
  scope: ClusterScope,
  resource: KubernetesResource,
  observedAt = new Date().toISOString(),
): NormalizedPodObservation {
  if (resource.kind !== "Pod" || !isResourceInScope(scope, resource)) {
    throw new ObservationNormalizationError("Pod is outside the approved observation scope");
  }
  const name = optionalString(resource.metadata.name) ?? "";
  const namespace = optionalString(resource.metadata.namespace) ?? "";
  const uid = optionalString(resource.metadata.uid) ?? "";
  if (!name || !namespace || !uid) {
    throw new ObservationNormalizationError("Pod observation requires name, namespace, and Kubernetes UID");
  }
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new ObservationNormalizationError("Pod observation timestamp is invalid");
  }
  const status = objectValue(resource.status);
  const phase = optionalString(status?.phase);
  const conditions = Array.isArray(status?.conditions) ? status.conditions : [];
  const readyCondition = conditions
    .map((condition) => objectValue(condition))
    .find((condition) => condition?.type === "Ready");
  const readyStatus = readyCondition?.status;
  const ready = readyStatus === "True" ? true : readyStatus === "False" ? false : null;
  const reason = optionalString(status?.reason) ?? optionalString(readyCondition?.reason);
  const sourceIdentity = `${scope.clusterId}:${uid}`;
  const resourceVersion = optionalString(resource.metadata.resourceVersion);
  const sourceKey = `${sourceIdentity}:${resourceVersion ?? "snapshot"}`;
  return {
    kind: "Pod",
    workspaceId: scope.workspaceId,
    clusterId: scope.clusterId,
    sourceIdentity,
    sourceKey,
    uid,
    name,
    namespace,
    resourceVersion,
    phase,
    ready,
    reason,
    observedAt: new Date(observedAt).toISOString(),
  };
}

export function isResourceInScope(scope: ClusterScope, resource: KubernetesResource): boolean {
  const metadata = objectValue(resource.metadata);
  const namespace = metadata?.namespace;
  return isSupportedResourceKind(resource.kind)
    && scope.resourceKinds.includes(resource.kind)
    && typeof namespace === "string"
    && scope.namespaces.includes(namespace);
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

function projectedKubernetesStatus(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const status = objectValue(value);
  if (!status) return undefined;
  const conditions = Array.isArray(status.conditions)
    ? status.conditions.flatMap((condition) => {
      const source = objectValue(condition);
      if (!source) return [];
      const type = optionalString(source.type);
      const conditionStatus = optionalString(source.status);
      if (!type || !conditionStatus) return [];
      return [{
        type,
        status: conditionStatus,
        ...(optionalString(source.reason) ? { reason: optionalString(source.reason) } : {}),
      }];
    })
    : [];
  return {
    ...(optionalString(status.phase) ? { phase: optionalString(status.phase) } : {}),
    ...(optionalString(status.reason) ? { reason: optionalString(status.reason) } : {}),
    ...(conditions.length > 0 ? { conditions } : {}),
  };
}

function projectPodResponse(value: unknown, namespace: string): KubernetesResource {
  const item = objectValue(value);
  const metadata = objectValue(item?.metadata);
  const name = optionalString(metadata?.name);
  const uid = optionalString(metadata?.uid);
  if (!name || !uid) throw new Error("Kubernetes Pod list returned an item without identity");
  const itemNamespace = optionalString(metadata?.namespace) ?? namespace;
  const resourceVersion = optionalString(metadata?.resourceVersion);
  const status = projectedKubernetesStatus(item?.status);
  return {
    kind: "Pod",
    metadata: {
      name,
      namespace: itemNamespace,
      uid,
      ...(resourceVersion ? { resourceVersion } : {}),
    },
    ...(status ? { status } : {}),
  };
}

export class ConfiguredKubernetesAdapter implements KubernetesObservationAdapter {
  readonly kind = "production" as const;
  contacted = false;

  constructor(readonly configuration: KubernetesAdapterConfiguration) {}

  private endpointForScope(scope: ClusterScope): URL {
    const configuredEndpoint = new URL(this.configuration.endpoint);
    const scopeEndpoint = new URL(scope.endpoint);
    if (configuredEndpoint.protocol !== "https:" || scopeEndpoint.protocol !== "https:" || configuredEndpoint.origin !== scopeEndpoint.origin) {
      throw new Error("Kubernetes scope endpoint does not match the configured observation endpoint");
    }
    const basePath = scopeEndpoint.pathname.replace(/\/$/, "");
    return new URL(`${basePath}/api/v1`, scope.endpoint);
  }

  async list(scope: ClusterScope): Promise<readonly KubernetesResource[]> {
    if (!scope.resourceKinds.includes("Pod")) return [];
    const resources: KubernetesResource[] = [];
    const apiEndpoint = this.endpointForScope(scope);
    for (const namespace of scope.namespaces) {
      const endpoint = new URL(`${apiEndpoint.pathname}/namespaces/${encodeURIComponent(namespace)}/pods`, apiEndpoint.origin);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        this.contacted = true;
        const response = await fetch(endpoint, {
          headers: { authorization: `Bearer ${this.configuration.token}`, accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Kubernetes Pod list failed with HTTP ${response.status}`);
        const body: unknown = await response.json();
        const items = objectValue(body)?.items;
        if (!Array.isArray(items)) throw new Error("Kubernetes Pod list returned an invalid response");
        resources.push(...items.map((item) => projectPodResponse(item, namespace)));
      } finally {
        clearTimeout(timeout);
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
