import {
  capabilities,
  hasCapability,
  type LogAccessAuditMetadata,
  type LogAuditStore,
  type MemberRecord,
} from "../../identity/src/index.js";
import type { ClusterScope } from "../../cluster/src/index.js";

export const LOG_MAX_LINES = 200;
export const LOG_MAX_BYTES = 1024 * 1024;

export type RecentLogWindowInput = Readonly<{
  clusterId: string;
  namespace: string;
  pod: string;
  container: string;
  tail: number;
}>;

export type RecentLogWindow = Readonly<RecentLogWindowInput & {
  body: string;
  lineCount: number;
  byteCount: number;
}>;

export type ValidationIssue = Readonly<{
  field: string;
  message: string;
}>;

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : null;
}

const clusterIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function isDnsSubdomain(value: string): boolean {
  return value.length <= 253 && value.split(".").every((label) => label.length <= 63 && dnsLabelPattern.test(label));
}

function stringField(value: RecordValue, field: string, maxLength: number, pattern: RegExp, issues: ValidationIssue[]): string {
  const fieldValue = value[field];
  const normalized = typeof fieldValue === "string" ? fieldValue.trim() : "";
  if (!normalized || normalized.length > maxLength || !pattern.test(normalized)) {
    issues.push({ field, message: `${field} is invalid` });
  }
  return normalized;
}

export type RecentLogWindowValidation =
  | Readonly<{ valid: true; value: RecentLogWindowInput }>
  | Readonly<{ valid: false; issues: readonly ValidationIssue[] }>;

export function validateRecentLogWindowInput(input: unknown): RecentLogWindowValidation {
  const value = record(input);
  if (!value) return { valid: false, issues: [{ field: "request", message: "request must be an object" }] };
  const issues: ValidationIssue[] = [];
  const clusterId = stringField(value, "clusterId", 128, clusterIdPattern, issues);
  const namespace = stringField(value, "namespace", 63, dnsLabelPattern, issues);
  const pod = typeof value.pod === "string" ? value.pod.trim() : "";
  if (!pod || !isDnsSubdomain(pod)) issues.push({ field: "pod", message: "pod is invalid" });
  const container = stringField(value, "container", 63, dnsLabelPattern, issues);
  const rawTail = value.tail;
  const tail = typeof rawTail === "number" && Number.isSafeInteger(rawTail) ? rawTail : Number.NaN;
  if (!Number.isSafeInteger(tail) || tail < 1 || tail > LOG_MAX_LINES) {
    issues.push({ field: "tail", message: `tail must be an integer from 1 to ${LOG_MAX_LINES}` });
  }
  if (issues.length > 0) return { valid: false, issues };
  return { valid: true, value: { clusterId, namespace, pod, container, tail } };
}

export class RecentLogWindowValidationError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super("Invalid Recent Log Window request");
    this.name = "RecentLogWindowValidationError";
  }
}

export function parseRecentLogWindowInput(input: unknown): RecentLogWindowInput {
  const result = validateRecentLogWindowInput(input);
  if (!result.valid) throw new RecentLogWindowValidationError(result.issues);
  return result.value;
}

export type KubernetesLogPayload = string | readonly string[];

export interface KubernetesLogAdapter {
  readonly kind: "fake" | "inert" | "production";
  readonly contacted: boolean;
  read(request: RecentLogWindowInput): Promise<KubernetesLogPayload>;
}

export type FakeLogFixture = Readonly<RecentLogWindowInput & {
  lines: readonly string[];
}>;

function sameRequest(left: RecentLogWindowInput, right: RecentLogWindowInput): boolean {
  return left.clusterId === right.clusterId
    && left.namespace === right.namespace
    && left.pod === right.pod
    && left.container === right.container;
}

export class FakeKubernetesLogAdapter implements KubernetesLogAdapter {
  readonly kind = "fake" as const;
  readonly contacted = false;
  readonly requests: RecentLogWindowInput[] = [];

  constructor(private readonly fixtures: readonly FakeLogFixture[] = []) {}

  async read(request: RecentLogWindowInput): Promise<KubernetesLogPayload> {
    this.requests.push({ ...request });
    const fixture = this.fixtures.find((candidate) => sameRequest(candidate, request));
    if (!fixture) throw new Error("Fake Kubernetes log fixture was not found");
    return [...fixture.lines];
  }
}

export class FakeLogAdapter extends FakeKubernetesLogAdapter {}

export class InertKubernetesLogAdapter implements KubernetesLogAdapter {
  readonly kind = "inert" as const;
  readonly contacted = false;

  async read(): Promise<KubernetesLogPayload> {
    throw new Error("Kubernetes log access is not configured");
  }
}

export type KubernetesLogAdapterConfiguration = Readonly<{
  endpoint: string;
  token: string;
  identity: "logs-reader";
}>;

function configuredValue(environment: Record<string, string | undefined>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function productionKubernetesLogConfiguration(
  environment: Record<string, string | undefined>,
): KubernetesLogAdapterConfiguration | null {
  const endpoint = configuredValue(environment, [
    "KUBERNETES_LOG_API_SERVER",
    "TRACEGARDEN_KUBERNETES_LOG_API_SERVER",
  ]);
  const token = configuredValue(environment, [
    "KUBERNETES_LOG_TOKEN",
    "TRACEGARDEN_KUBERNETES_LOG_TOKEN",
  ]);
  const observationToken = configuredValue(environment, [
    "KUBERNETES_OBSERVATION_TOKEN",
    "TRACEGARDEN_KUBERNETES_TOKEN",
  ]);
  if (!endpoint || !token || token === observationToken) return null;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password) return null;
  } catch {
    return null;
  }
  return { endpoint, token, identity: "logs-reader" };
}

export type KubernetesLogFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let lineCount = 0;
  try {
    while (totalBytes < LOG_MAX_BYTES && lineCount < LOG_MAX_LINES) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      let accepted = 0;
      while (accepted < chunk.length && totalBytes < LOG_MAX_BYTES) {
        totalBytes += 1;
        if (chunk[accepted] === 10) lineCount += 1;
        accepted += 1;
        if (lineCount >= LOG_MAX_LINES) break;
      }
      if (accepted > 0) chunks.push(chunk.slice(0, accepted));
      if (lineCount >= LOG_MAX_LINES || totalBytes >= LOG_MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

export class ConfiguredKubernetesLogAdapter implements KubernetesLogAdapter {
  readonly kind = "production" as const;
  readonly contacted = false;

  constructor(
    readonly configuration: KubernetesLogAdapterConfiguration,
    private readonly fetcher: KubernetesLogFetcher = (input, init) => fetch(input, init),
  ) {}

  async read(request: RecentLogWindowInput): Promise<KubernetesLogPayload> {
    const endpoint = new URL(this.configuration.endpoint);
    const basePath = endpoint.pathname.replace(/\/$/, "");
    endpoint.pathname = `${basePath}/api/v1/namespaces/${encodeURIComponent(request.namespace)}/pods/${encodeURIComponent(request.pod)}/log`;
    endpoint.searchParams.set("container", request.container);
    endpoint.searchParams.set("tailLines", String(request.tail));
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        headers: { authorization: `Bearer ${this.configuration.token}` },
      });
    } catch {
      throw new Error("Kubernetes log request failed");
    }
    if (!response.ok) throw new Error("Kubernetes log request was rejected");
    try {
      return readBoundedResponse(response);
    } catch {
      throw new Error("Kubernetes log response could not be read");
    }
  }
}

export function createKubernetesLogAdapter(
  environment: Record<string, string | undefined> = process.env,
): KubernetesLogAdapter {
  const configuration = productionKubernetesLogConfiguration(environment);
  return configuration ? new ConfiguredKubernetesLogAdapter(configuration) : new InertKubernetesLogAdapter();
}

function normalizeLines(payload: KubernetesLogPayload): string[] {
  const rawLines = typeof payload === "string" ? payload.split(/\r?\n/) : payload.flatMap((line) => line.split(/\r?\n/));
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  return rawLines;
}

function continuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length <= maximumBytes) return value;
  let end = maximumBytes;
  if (continuationByte(encoded[end])) {
    let lead = end - 1;
    while (lead >= 0 && continuationByte(encoded[lead])) lead -= 1;
    const leadByte = encoded[lead];
    const expectedBytes = leadByte !== undefined && leadByte >= 0xf0
      ? 4
      : leadByte !== undefined && leadByte >= 0xe0
        ? 3
        : leadByte !== undefined && leadByte >= 0xc0
          ? 2
          : 1;
    if (lead < 0 || end - lead < expectedBytes) end = Math.max(0, lead);
  }
  return new TextDecoder().decode(encoded.slice(0, end));
}

export function boundRecentLogWindow(payload: KubernetesLogPayload, tail: number): Readonly<{
  body: string;
  lineCount: number;
  byteCount: number;
}> {
  const lines = normalizeLines(payload).slice(-tail).slice(-LOG_MAX_LINES);
  const body = utf8Prefix(lines.join("\n"), LOG_MAX_BYTES);
  const lineCount = body ? body.split("\n").length : 0;
  return { body, lineCount, byteCount: new TextEncoder().encode(body).length };
}

export type RecentLogTelemetryEvent = Readonly<{
  action: "recent_log.accessed";
  clusterId: string;
  namespace: string;
  pod: string;
  container: string;
  tail: string;
  lineCount: string;
  byteCount: string;
}>;

export type RecentLogTelemetry = Readonly<{
  structuredLog?: (event: RecentLogTelemetryEvent) => void;
  trace?: (event: RecentLogTelemetryEvent) => void;
  metric?: (event: RecentLogTelemetryEvent) => void;
  analytics?: (event: RecentLogTelemetryEvent) => void;
}>;

export type RecentLogRequestOptions = Readonly<{
  member: Pick<MemberRecord, "id" | "workspaceId" | "capabilities">;
  scope: ClusterScope | null;
  input: unknown;
  adapter: KubernetesLogAdapter;
  auditStore?: LogAuditStore;
  telemetry?: RecentLogTelemetry;
}>;

function metadataFor(request: RecentLogWindowInput, lineCount: number, byteCount: number): LogAccessAuditMetadata {
  return {
    clusterId: request.clusterId,
    namespace: request.namespace,
    pod: request.pod,
    container: request.container,
    tail: String(request.tail),
    lineCount: String(lineCount),
    byteCount: String(byteCount),
  };
}

function emitTelemetry(telemetry: RecentLogTelemetry | undefined, event: RecentLogTelemetryEvent): void {
  if (!telemetry) return;
  for (const emitter of [telemetry.structuredLog, telemetry.trace, telemetry.metric, telemetry.analytics]) {
    try {
      emitter?.(event);
    } catch {
      // Telemetry is best effort and never changes the ephemeral response.
    }
  }
}

function validateScope(scope: ClusterScope | null, request: RecentLogWindowInput, workspaceId: string): void {
  if (!scope || scope.workspaceId !== workspaceId || scope.clusterId !== request.clusterId) {
    throw new RecentLogWindowValidationError([{ field: "clusterId", message: "cluster is not configured" }]);
  }
  if (!scope.namespaces.includes(request.namespace)) {
    throw new RecentLogWindowValidationError([{ field: "namespace", message: "namespace is outside the approved scope" }]);
  }
}

export async function requestRecentLogWindow(options: RecentLogRequestOptions): Promise<RecentLogWindow> {
  if (!hasCapability(options.member, capabilities.logsRead)) {
    throw new Error("Missing capability: logs:read");
  }
  const request = parseRecentLogWindowInput(options.input);
  validateScope(options.scope, request, options.member.workspaceId);
  let bounded: Readonly<{ body: string; lineCount: number; byteCount: number }>;
  try {
    bounded = boundRecentLogWindow(await options.adapter.read(request), request.tail);
  } catch {
    throw new Error("Recent Log Window is unavailable");
  }
  const metadata = metadataFor(request, bounded.lineCount, bounded.byteCount);
  if (options.auditStore) {
    try {
      await options.auditStore.recordLogAccess(options.member, metadata);
    } catch {
      throw new Error("Recent Log Window audit is unavailable");
    }
  }
  emitTelemetry(options.telemetry, {
    action: "recent_log.accessed",
    ...metadata,
  });
  return { ...request, ...bounded };
}

export function hasLogReadCapability(member: Pick<MemberRecord, "capabilities">): boolean {
  return hasCapability(member, capabilities.logsRead);
}
