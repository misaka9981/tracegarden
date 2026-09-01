import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { state, type StatusResponse } from "../../../packages/contracts/src/index.js";
import {
  collectScopedResources,
  compareResourceVersions,
  createKubernetesAdapter,
  isResourceInScope,
  KubernetesWatchDisconnectedError,
  KubernetesWatchGoneError,
  normalizeObservation,
  type ClusterScope,
  type KubernetesListResult,
  type KubernetesObservationAdapter,
  type KubernetesResource,
  type KubernetesWatchEvent,
  type NormalizedObservation,
} from "../../../packages/cluster/src/index.js";
import {
  PostgresDatabase,
  type DatabaseBoundary,
  type IngestionCheckpoint,
  type IngestionCheckpointInput,
  type ObservationPersistenceResult,
  type TimelineStore,
} from "../../../packages/db/src/index.js";
import { WORKSPACE_ID } from "../../../packages/identity/src/index.js";
import type { RetentionStore } from "../../../packages/domain/src/index.js";
import { createTelemetry, type TelemetryRuntime } from "../../../packages/telemetry/src/index.js";

export type CollectorBackoffPolicy = Readonly<{
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  maxReconnectAttempts: number;
}>;

export const DEFAULT_COLLECTOR_BACKOFF: CollectorBackoffPolicy = {
  initialDelayMs: 100,
  maxDelayMs: 5_000,
  multiplier: 2,
  maxReconnectAttempts: 5,
};

export type CollectorSignals = Readonly<{
  lagSeconds: number;
  reconnects: number;
  relists: number;
  normalizationFailures: number;
  persistenceFailures: number;
  lastResourceVersion: string | null;
  lastEventAt: string | null;
  backoffDelaysMs: readonly number[];
  failedNamespaces: readonly string[];
}>;

export type CollectorRetentionScheduler = (task: () => void, intervalMs: number) => () => void;

export type CollectorOptions = Readonly<{
  port?: number;
  host?: string;
  environment?: Record<string, string | undefined>;
  scope?: ClusterScope;
  adapter?: KubernetesObservationAdapter;
  database?: DatabaseBoundary;
  observationStore?: TimelineStore;
  retentionStore?: RetentionStore;
  collectOnStart?: boolean;
  backoff?: Partial<CollectorBackoffPolicy>;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
  retentionCleanupIntervalMs?: number;
  retentionCleanupScheduler?: CollectorRetentionScheduler;
  telemetry?: TelemetryRuntime;
}>;

export type CollectorWatchOptions = Readonly<{
  maxReconnectAttempts?: number;
  signal?: AbortSignal;
}>;

export class CollectorRecoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CollectorRecoveryError";
  }
}

class CollectorWatchBudgetExhaustedError extends CollectorRecoveryError {}

export type CollectorRuntime = Readonly<{
  server: Server;
  status: () => StatusResponse;
  signals: () => CollectorSignals;
  collect: () => Promise<readonly KubernetesResource[]>;
  collectNormalized: () => Promise<readonly NormalizedObservation[]>;
  collectObservations: () => Promise<readonly ObservationPersistenceResult[]>;
  runWatch: (options?: CollectorWatchOptions) => Promise<void>;
  close: () => Promise<void>;
  telemetry: TelemetryRuntime;
}>;

export function collectorStatus(): StatusResponse {
  return {
    service: "tracegarden-collector",
    status: state(false),
    startup: "ready",
    readiness: "not-ready",
    liveness: "alive",
    checks: {
      database: "not-ready",
      migrations: "not-ready",
      collector: "not-ready",
      clusterContacted: false,
    },
  };
}

function resourceVersion(resource: KubernetesResource): string | null {
  const value = resource.metadata.resourceVersion;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function listResourceVersion(result: KubernetesListResult): string | null {
  if (typeof result.resourceVersion === "string" && result.resourceVersion.trim()) return result.resourceVersion.trim();
  let latest: string | null = null;
  for (const resource of result.resources) {
    const version = resourceVersion(resource);
    if (version && (!latest || compareResourceVersions(version, latest) > 0)) latest = version;
  }
  return latest;
}

function listenForStartup(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onListening = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const onError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      server.removeListener("listening", onListening);
      reject(error);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      onError(error);
    }
  });
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener("abort", finish, { once: true });
    timer = setTimeout(finish, milliseconds);
  });
}

async function cancellableSleep(
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = (): void => finish();
    signal.addEventListener("abort", abort, { once: true });
    void sleep(milliseconds, signal).then(finish, (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

function backoffDelay(policy: CollectorBackoffPolicy, attempt: number): number {
  return Math.min(policy.maxDelayMs, policy.initialDelayMs * policy.multiplier ** attempt);
}

function namespaceScope(scope: ClusterScope, namespace: string): ClusterScope {
  return { ...scope, namespaces: [namespace] };
}

function checkpointInput(scope: ClusterScope, namespace: string, resourceVersionValue: string): IngestionCheckpointInput {
  return {
    workspaceId: scope.workspaceId,
    clusterId: scope.clusterId,
    namespace,
    resourceKind: "Pod",
    resourceVersion: resourceVersionValue,
  };
}

function checkpointIdentity(scope: ClusterScope, namespace: string): Omit<IngestionCheckpointInput, "resourceVersion"> {
  return {
    workspaceId: scope.workspaceId,
    clusterId: scope.clusterId,
    namespace,
    resourceKind: "Pod",
  };
}

function hasRetentionStore(value: unknown): value is RetentionStore {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RetentionStore>;
  return typeof candidate.getRetentionPolicy === "function"
    && typeof candidate.updateRetentionPolicy === "function"
    && typeof candidate.cleanupRetention === "function";
}

function hasCollectionPreconditions(scope: ClusterScope | null, adapter: KubernetesObservationAdapter): scope is ClusterScope {
  return Boolean(scope && adapter.kind !== "inert" && scope.namespaces.length > 0 && scope.resourceKinds.includes("Pod"));
}

function isGone(error: unknown): boolean {
  return error instanceof KubernetesWatchGoneError
    || (typeof error === "object" && error !== null
      && (("statusCode" in error && (error as { statusCode?: unknown }).statusCode === 410)
        || ("code" in error && (error as { code?: unknown }).code === 410)));
}

function watchEventStatusCode(event: KubernetesWatchEvent): number | undefined {
  const status = event.resource?.status;
  const statusCode = typeof status === "object" && status !== null ? status.code : undefined;
  const rawCode = event.statusCode ?? event.resource?.code ?? statusCode;
  return typeof rawCode === "number"
    ? Number.isSafeInteger(rawCode) ? rawCode : undefined
    : typeof rawCode === "string" && /^\d+$/.test(rawCode.trim()) ? Number(rawCode) : undefined;
}

function watchEventReason(event: KubernetesWatchEvent): string | null {
  if (event.reason) return event.reason;
  const resourceReason = event.resource?.reason;
  return typeof resourceReason === "string" && resourceReason.trim() ? resourceReason.trim() : null;
}

function shouldAdvanceResourceVersion(candidate: string, current: string | null): boolean {
  if (!current || candidate === current) return !current;
  const candidateIsDecimal = /^\d+$/.test(candidate);
  const currentIsDecimal = /^\d+$/.test(current);
  return candidateIsDecimal && currentIsDecimal
    ? compareResourceVersions(candidate, current) > 0
    : true;
}

export async function createCollectorRuntime(options: CollectorOptions = {}): Promise<CollectorRuntime> {
  const environment = options.environment ?? process.env;
  const production = environment.NODE_ENV === "production";
  if (production && options.telemetry) {
    throw new Error("Production collector instrumentation must be application-owned");
  }
  const telemetry = options.telemetry ?? createTelemetry({
    serviceName: "tracegarden-collector",
    logExporter: (signal) => console.log(JSON.stringify(signal)),
    traceExporter: (signal) => console.log(JSON.stringify(signal)),
  });
  const startupCorrelation = telemetry.correlation("collector-startup");
  telemetry.log("info", "collector.starting", startupCorrelation);
  if (production && (options.database || options.observationStore || options.retentionStore)) {
    throw new Error("Production collector stores must be database-owned");
  }
  if (production && !environment.TIMELINE_CURSOR_SECRET?.trim()) {
    throw new Error("TIMELINE_CURSOR_SECRET is required in production");
  }
  const cursorSecret = environment.TIMELINE_CURSOR_SECRET?.trim();
  const adapter = options.adapter ?? createKubernetesAdapter(environment);
  const ownsDatabase = !options.database && !options.observationStore && !options.retentionStore && Boolean(environment.DATABASE_URL);
  const database = options.database ?? (ownsDatabase && environment.DATABASE_URL
    ? cursorSecret ? new PostgresDatabase(environment.DATABASE_URL, undefined, cursorSecret) : new PostgresDatabase(environment.DATABASE_URL)
    : undefined);
  const observationStore = options.observationStore ?? database?.timeline;
  const retentionStore = options.retentionStore ?? database?.retention ?? (hasRetentionStore(observationStore) ? observationStore : undefined);
  let databaseReady = database === undefined;
  let migrationReady = database === undefined;
  let startupState: "starting" | "ready" | "failed" = "starting";
  if (production && (!ownsDatabase || database?.kind !== "postgres" || !database.timeline || !database.retention || observationStore !== database.timeline || retentionStore !== database.retention || !hasRetentionStore(retentionStore))) {
    if (ownsDatabase) await database?.close();
    throw new Error("Production collector requires database-owned observation and retention stores");
  }
  if (database) {
    try {
      if (database.verifyMigrations) await database.verifyMigrations();
      else if (database.kind !== "memory" && database.migrationStatus?.() !== "ready") {
        throw new Error("Tracegarden collector migration state cannot be verified");
      }
      migrationReady = database.migrationStatus?.() !== "failed";
      databaseReady = await database.ping();
      if (!databaseReady) throw new Error("Tracegarden collector database readiness check failed");
    } catch (error) {
      startupState = "failed";
      telemetry.log("error", "collector.startup.failure", startupCorrelation, { error_type: error instanceof Error ? error.name : "unknown" });
      if (ownsDatabase) await database.close();
      throw error;
    }
  }

  const policy: CollectorBackoffPolicy = {
    ...DEFAULT_COLLECTOR_BACKOFF,
    ...(options.backoff ?? {}),
  };
  if (!Number.isFinite(policy.initialDelayMs) || policy.initialDelayMs < 0
    || !Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.initialDelayMs
    || !Number.isFinite(policy.multiplier) || policy.multiplier < 1
    || !Number.isSafeInteger(policy.maxReconnectAttempts) || policy.maxReconnectAttempts < 0) {
    throw new Error("Invalid collector backoff policy");
  }
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const configuredRetentionInterval = options.retentionCleanupIntervalMs
    ?? (environment.RETENTION_CLEANUP_INTERVAL_MS ? Number(environment.RETENTION_CLEANUP_INTERVAL_MS) : 24 * 60 * 60 * 1000);
  if (!Number.isSafeInteger(configuredRetentionInterval) || configuredRetentionInterval <= 0) {
    throw new Error("Invalid retention cleanup interval");
  }
  const signalState = {
    lagSeconds: 0,
    reconnects: 0,
    relists: 0,
    normalizationFailures: 0,
    persistenceFailures: 0,
    lastResourceVersion: null as string | null,
    lastEventAt: null as string | null,
    backoffDelaysMs: [] as number[],
    failedNamespaces: [] as string[],
  };
  const signalSnapshot = (): CollectorSignals => ({
    ...signalState,
    backoffDelaysMs: [...signalState.backoffDelaysMs],
    failedNamespaces: [...signalState.failedNamespaces],
  });
  const defineCollectorMetrics = (): void => {
    telemetry.defineGauge("tracegarden_collector_lag_seconds");
    telemetry.defineCounter("tracegarden_collector_reconnects_total");
    telemetry.defineCounter("tracegarden_collector_relists_total");
    telemetry.defineCounter("tracegarden_collector_normalization_failures_total");
    telemetry.defineCounter("tracegarden_collector_persistence_failures_total");
    telemetry.defineGauge("tracegarden_collector_failed_namespaces");
    telemetry.defineGauge("tracegarden_collector_last_resource_version");
    telemetry.defineGauge("tracegarden_collector_database_ready");
    telemetry.defineGauge("tracegarden_collector_migrations_ready");
    telemetry.defineGauge("tracegarden_database_pool_total");
    telemetry.defineGauge("tracegarden_database_pool_idle");
    telemetry.defineGauge("tracegarden_database_pool_waiting");
    telemetry.defineGauge("tracegarden_migration_status");
  };
  defineCollectorMetrics();
  const syncCollectorMetrics = (): void => {
    const signals = signalSnapshot();
    const correlation = telemetry.correlation("collector-signals");
    telemetry.setGauge("tracegarden_collector_lag_seconds", signals.lagSeconds, {}, correlation);
    telemetry.setCounter("tracegarden_collector_reconnects_total", signals.reconnects, {}, correlation);
    telemetry.setCounter("tracegarden_collector_relists_total", signals.relists, {}, correlation);
    telemetry.setCounter("tracegarden_collector_normalization_failures_total", signals.normalizationFailures, {}, correlation);
    telemetry.setCounter("tracegarden_collector_persistence_failures_total", signals.persistenceFailures, {}, correlation);
    telemetry.setGauge("tracegarden_collector_failed_namespaces", signals.failedNamespaces.length, {}, correlation);
    telemetry.setGauge("tracegarden_collector_last_resource_version", signals.lastResourceVersion && /^\d+$/.test(signals.lastResourceVersion) ? Number(signals.lastResourceVersion) : 0, {}, correlation);
    telemetry.setGauge("tracegarden_collector_database_ready", databaseReady ? 1 : 0, {}, correlation);
    telemetry.setGauge("tracegarden_collector_migrations_ready", migrationReady ? 1 : 0, {}, correlation);
    let pool = { total: 0, idle: 0, waiting: 0 };
    try {
      pool = database?.poolState?.() ?? pool;
    } catch {
      // Pool gauges are diagnostic and cannot affect probe behavior.
    }
    telemetry.setGauge("tracegarden_database_pool_total", pool.total, {}, correlation);
    telemetry.setGauge("tracegarden_database_pool_idle", pool.idle, {}, correlation);
    telemetry.setGauge("tracegarden_database_pool_waiting", pool.waiting, {}, correlation);
    let migrationValue = migrationReady ? 1 : 0;
    try {
      if (database?.migrationStatus?.() === "failed") migrationValue = -1;
    } catch {
      migrationValue = -1;
    }
    telemetry.setGauge("tracegarden_migration_status", migrationValue, {}, correlation);
  };
  const refreshDatabaseReadiness = async (): Promise<void> => {
    if (!database) {
      databaseReady = true;
      return;
    }
    try {
      databaseReady = await database.ping();
    } catch {
      databaseReady = false;
    }
  };
  const rememberResourceVersion = (version: string): void => {
    if (!signalState.lastResourceVersion || compareResourceVersions(version, signalState.lastResourceVersion) > 0) {
      signalState.lastResourceVersion = version;
    }
  };
  let stopping = false;
  let collectionReady = false;
  const shutdownController = new AbortController();
  let activeWatch: Promise<void> | null = null;
  let activeRetentionCleanup: Promise<void> | null = null;
  let cancelRetentionCleanup: (() => void) | undefined;
  const runScheduledRetentionCleanup = async (): Promise<void> => {
    if (!retentionStore || stopping) return;
    try {
      const result = await retentionStore.cleanupRetention(WORKSPACE_ID, now());
      if (result.failures > 0) telemetry.log("warn", "collector.retention_cleanup.failure", telemetry.correlation("collector-retention"), { failures: result.failures });
    } catch {
      telemetry.log("warn", "collector.retention_cleanup.failure", telemetry.correlation("collector-retention"), { error_type: "unknown" });
    }
  };
  const scheduleRetentionCleanup = options.retentionCleanupScheduler ?? ((task: () => void, intervalMs: number): (() => void) => {
    const timer = setInterval(task, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  });

  const configuredScope = async (): Promise<ClusterScope | null> => options.scope ?? await database?.clusterScope?.get(WORKSPACE_ID) ?? null;
  try {
    const initialScope = await configuredScope();
    collectionReady = hasCollectionPreconditions(initialScope, adapter);
  } catch {
    databaseReady = false;
    collectionReady = false;
  }

  const list = async (scope: ClusterScope, signal?: AbortSignal): Promise<KubernetesListResult> => {
    signal?.throwIfAborted();
    if (adapter.listResult) {
      const result = await adapter.listResult(scope, signal);
      return { ...result, resources: result.resources.filter((resource) => isResourceInScope(scope, resource)) };
    }
    const resources = (await adapter.list(scope, signal)).filter((resource) => isResourceInScope(scope, resource));
    return { resources, resourceVersion: listResourceVersion({ resources }) };
  };
  const normalizeResources = (scope: ClusterScope, resources: readonly KubernetesResource[], observedAt?: string): NormalizedObservation[] => {
    const normalized: NormalizedObservation[] = [];
    for (const resource of resources) {
      try {
        normalized.push(normalizeObservation(scope, resource, observedAt ?? now().toISOString()));
      } catch (error) {
        signalState.normalizationFailures += 1;
        telemetry.log("error", "collector.normalization.failure", telemetry.correlation("collector-normalization"), { error_type: error instanceof Error ? error.name : "unknown" });
        syncCollectorMetrics();
        throw new CollectorRecoveryError("Collector recovery boundary: observation normalization failed", { cause: error });
      }
    }
    return normalized;
  };

  const collectNormalized = async (): Promise<readonly NormalizedObservation[]> => {
    const scope = await configuredScope();
    if (!hasCollectionPreconditions(scope, adapter)) {
      collectionReady = false;
      syncCollectorMetrics();
      return [];
    }
    return normalizeResources(scope, await collectScopedResources(scope, adapter));
  };

  const persistWithCheckpoint = async (
    normalized: readonly NormalizedObservation[],
    checkpoint: IngestionCheckpointInput,
  ): Promise<readonly ObservationPersistenceResult[]> => {
    if (!observationStore?.recordObservationsAndCheckpoint) {
      signalState.persistenceFailures += 1;
      telemetry.log("error", "collector.persistence.failure", telemetry.correlation("collector-persistence"), { error_type: "unavailable" });
      syncCollectorMetrics();
      throw new CollectorRecoveryError("Collector recovery boundary: transactional checkpoint persistence is unavailable");
    }
    try {
      const result = await observationStore.recordObservationsAndCheckpoint(normalized, checkpoint);
      rememberResourceVersion(checkpoint.resourceVersion);
      return result;
    } catch (error) {
      signalState.persistenceFailures += 1;
      telemetry.log("error", "collector.persistence.failure", telemetry.correlation("collector-persistence"), { error_type: error instanceof Error ? error.name : "unknown" });
      syncCollectorMetrics();
      throw new CollectorRecoveryError("Collector recovery boundary: observation and checkpoint persistence failed", { cause: error });
    }
  };

  const persistWithoutCheckpoint = async (
    normalized: readonly NormalizedObservation[],
  ): Promise<readonly ObservationPersistenceResult[]> => {
    if (!observationStore) {
      signalState.persistenceFailures += 1;
      telemetry.log("error", "collector.persistence.failure", telemetry.correlation("collector-persistence"), { error_type: "unavailable" });
      syncCollectorMetrics();
      throw new CollectorRecoveryError("Collector recovery boundary: observation persistence is unavailable");
    }
    try {
      if (observationStore.recordObservations) return await observationStore.recordObservations(normalized);
      const persisted: ObservationPersistenceResult[] = [];
      for (const observation of normalized) persisted.push(await observationStore.recordObservation(observation));
      return persisted;
    } catch (error) {
      if (error instanceof CollectorRecoveryError) throw error;
      signalState.persistenceFailures += 1;
      telemetry.log("error", "collector.persistence.failure", telemetry.correlation("collector-persistence"), { error_type: error instanceof Error ? error.name : "unknown" });
      syncCollectorMetrics();
      throw new CollectorRecoveryError("Collector recovery boundary: observation persistence failed", { cause: error });
    }
  };

  const collect = async (): Promise<readonly KubernetesResource[]> => {
    const scope = await configuredScope();
    return scope ? collectScopedResources(scope, adapter) : [];
  };

  const collectObservations = async (): Promise<readonly ObservationPersistenceResult[]> => {
    const span = telemetry.startSpan("collector.collect_observations", telemetry.correlation("collector-collect"));
    try {
      const scope = await configuredScope();
      if (!hasCollectionPreconditions(scope, adapter)) {
        collectionReady = false;
        syncCollectorMetrics();
        span.end({ observations: 0 });
        return [];
      }
      const normalized = await collectNormalized();
      const persisted = await persistWithoutCheckpoint(normalized);
      collectionReady = true;
      span.end({ observations: persisted.length });
      return persisted;
    } catch (error) {
      collectionReady = false;
      span.fail(error);
      throw error;
    }
  };

  const synchronizeList = async (
    scope: ClusterScope,
    namespace: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const result = await list(namespaceScope(scope, namespace), signal);
    const version = listResourceVersion(result);
    if (!version) {
      throw new CollectorRecoveryError("Collector recovery boundary: Kubernetes list did not return a resourceVersion");
    }
    const normalized = normalizeResources(namespaceScope(scope, namespace), result.resources);
    await persistWithCheckpoint(normalized, checkpointInput(scope, namespace, version));
    return version;
  };

  const checkpoint = async (scope: ClusterScope, namespace: string): Promise<IngestionCheckpoint | null> => {
    if (!observationStore?.getIngestionCheckpoint) return null;
    try {
      return await observationStore.getIngestionCheckpoint(scope.workspaceId, scope.clusterId, "Pod", namespace);
    } catch (error) {
      signalState.persistenceFailures += 1;
      telemetry.log("error", "collector.persistence.failure", telemetry.correlation("collector-persistence"), { error_type: error instanceof Error ? error.name : "unknown" });
      syncCollectorMetrics();
      throw new CollectorRecoveryError("Collector recovery boundary: ingestion checkpoint read failed", { cause: error });
    }
  };

  const clearCheckpoint = async (scope: ClusterScope, namespace: string): Promise<void> => {
    if (!observationStore?.clearIngestionCheckpoint) {
      signalState.persistenceFailures += 1;
      telemetry.log("error", "collector.persistence.failure", telemetry.correlation("collector-persistence"), { error_type: "unavailable" });
      syncCollectorMetrics();
      throw new CollectorRecoveryError("Collector recovery boundary: transactional checkpoint clearing is unavailable");
    }
    try {
      await observationStore.clearIngestionCheckpoint(checkpointIdentity(scope, namespace));
    } catch (error) {
      signalState.persistenceFailures += 1;
      telemetry.log("error", "collector.persistence.failure", telemetry.correlation("collector-persistence"), { error_type: error instanceof Error ? error.name : "unknown" });
      syncCollectorMetrics();
      throw new CollectorRecoveryError("Collector recovery boundary: ingestion checkpoint clearing failed", { cause: error });
    }
  };

  const updateLag = (observedAt: string | undefined): void => {
    if (!observedAt) return;
    const parsed = Date.parse(observedAt);
    if (!Number.isFinite(parsed)) return;
    signalState.lastEventAt = new Date(parsed).toISOString();
    signalState.lagSeconds = Math.max(0, (now().getTime() - parsed) / 1_000);
    syncCollectorMetrics();
  };

  const runWatch = async (watchOptions: CollectorWatchOptions = {}): Promise<void> => {
    const maxReconnectAttempts = watchOptions.maxReconnectAttempts ?? policy.maxReconnectAttempts;
    if (!Number.isSafeInteger(maxReconnectAttempts) || maxReconnectAttempts < 0) {
      throw new Error("Invalid collector maxReconnectAttempts override");
    }
    if (activeWatch) return activeWatch;
    const promise = (async (): Promise<void> => {
      const scope = await configuredScope();
      if (!hasCollectionPreconditions(scope, adapter)) {
        collectionReady = false;
        syncCollectorMetrics();
        return;
      }
      const watch = adapter.watch;
      if (!watch) {
        collectionReady = false;
        syncCollectorMetrics();
        throw new CollectorRecoveryError("Collector recovery boundary: Kubernetes watch is unavailable");
      }
      if (!observationStore?.getIngestionCheckpoint) {
        collectionReady = false;
        syncCollectorMetrics();
        throw new CollectorRecoveryError("Collector recovery boundary: durable namespace checkpoints are unavailable");
      }
      const watchController = new AbortController();
      const abortWatch = (): void => watchController.abort();
      shutdownController.signal.addEventListener("abort", abortWatch, { once: true });
      watchOptions.signal?.addEventListener("abort", abortWatch, { once: true });
      if (shutdownController.signal.aborted || watchOptions.signal?.aborted) watchController.abort();
      const signal = watchController.signal;
      const runNamespace = async (namespace: string): Promise<void> => {
        const streamScope = namespaceScope(scope, namespace);
        let currentVersion = (await checkpoint(scope, namespace))?.resourceVersion ?? null;
        if (currentVersion) rememberResourceVersion(currentVersion);
        let needsRelist = !currentVersion;
        let recoveryAttempts = 0;
        let backoffAttempts = 0;
        while (!stopping && !signal.aborted) {
          try {
            if (needsRelist) {
              currentVersion = await synchronizeList(scope, namespace, signal);
              needsRelist = false;
            }
            const stream = await watch.call(adapter, streamScope, currentVersion, signal);
            for await (const event of stream) {
              if (stopping || signal.aborted) return;
              if (event.type === "ERROR") {
                const reason = watchEventReason(event);
                if (watchEventStatusCode(event) === 410) throw new KubernetesWatchGoneError(reason ?? "Kubernetes watch resource version is gone");
                throw new KubernetesWatchDisconnectedError(reason ?? "Kubernetes watch returned an error");
              }
              const eventVersion = typeof event.resourceVersion === "string" && event.resourceVersion.trim()
                ? event.resourceVersion.trim()
                : null;
              const version = eventVersion ?? (event.resource ? resourceVersion(event.resource) : null);
              updateLag(event.observedAt);
              if (event.type === "BOOKMARK") {
                if (version && shouldAdvanceResourceVersion(version, currentVersion)) {
                  await persistWithCheckpoint([], checkpointInput(scope, namespace, version));
                  collectionReady = true;
                  currentVersion = version;
                }
                continue;
              }
              if (!event.resource) throw new KubernetesWatchDisconnectedError("Kubernetes watch event has no resource");
              const observedAt = event.observedAt ?? now().toISOString();
              const normalized = normalizeResources(streamScope, [event.resource], observedAt);
              if (version && shouldAdvanceResourceVersion(version, currentVersion)) {
                await persistWithCheckpoint(normalized, checkpointInput(scope, namespace, version));
                collectionReady = true;
                currentVersion = version;
              } else {
                await persistWithoutCheckpoint(normalized);
                collectionReady = true;
              }
              updateLag(observedAt);
            }
            throw new KubernetesWatchDisconnectedError();
          } catch (error) {
            if (error instanceof CollectorRecoveryError) throw error;
            if (stopping || signal.aborted || watchOptions.signal?.aborted) return;
            if (recoveryAttempts >= maxReconnectAttempts) {
              throw new CollectorWatchBudgetExhaustedError("Collector recovery boundary: bounded Kubernetes watch reconnect/recovery attempts exhausted", { cause: error });
            }
            recoveryAttempts += 1;
            if (isGone(error)) {
              signalState.relists += 1;
              telemetry.log("warn", "collector.watch.relist", telemetry.correlation("collector-watch"), { namespace, error_type: "resource_version_gone" });
              syncCollectorMetrics();
              currentVersion = null;
              needsRelist = true;
              await clearCheckpoint(scope, namespace);
              continue;
            }
            signalState.reconnects += 1;
            const delay = backoffDelay(policy, backoffAttempts);
            telemetry.log("warn", "collector.watch.reconnect", telemetry.correlation("collector-watch"), { namespace, attempt: recoveryAttempts, delay_ms: delay, error_type: error instanceof Error ? error.name : "unknown" });
            backoffAttempts += 1;
            signalState.backoffDelaysMs.push(delay);
            syncCollectorMetrics();
            await cancellableSleep(sleep, delay, signal);
          }
        }
      };
      const budgetFailures: CollectorWatchBudgetExhaustedError[] = [];
      const runNamespaceWithIsolation = async (namespace: string): Promise<boolean> => {
        try {
          await runNamespace(namespace);
          return true;
        } catch (error) {
          if (!(error instanceof CollectorWatchBudgetExhaustedError)) throw error;
          if (!signalState.failedNamespaces.includes(namespace)) signalState.failedNamespaces.push(namespace);
          budgetFailures.push(error);
          return false;
        }
      };
      try {
        const namespaceResults = await Promise.all(scope.namespaces.map(runNamespaceWithIsolation));
        collectionReady = namespaceResults.every((result) => result);
        if (namespaceResults.every((result) => !result) && budgetFailures[0]) throw budgetFailures[0];
      } catch (error) {
        collectionReady = false;
        telemetry.log("error", "collector.watch.failure", telemetry.correlation("collector-watch"), { error_type: error instanceof Error ? error.name : "unknown" });
        watchController.abort();
        throw error;
      } finally {
        shutdownController.signal.removeEventListener("abort", abortWatch);
        watchOptions.signal?.removeEventListener("abort", abortWatch);
      }
    })();
    activeWatch = promise;
    try {
      await promise;
    } finally {
      activeWatch = null;
    }
  };

  const runtimeStatus = (): StatusResponse => {
    try {
      const migrationStatus = database?.migrationStatus?.();
      if (migrationStatus === "failed" || migrationStatus === "pending") migrationReady = false;
      if (migrationStatus === "ready") migrationReady = true;
    } catch {
      migrationReady = false;
    }
    syncCollectorMetrics();
    const currentSignals = signalSnapshot();
    const readiness = state(databaseReady && migrationReady && collectionReady && startupState === "ready");
    return {
      service: "tracegarden-collector",
      status: readiness,
      startup: startupState,
      readiness,
      liveness: stopping ? "stopping" : "alive",
      checks: {
        database: state(databaseReady),
        migrations: state(migrationReady),
        collector: state(collectionReady && startupState === "ready"),
        clusterContacted: adapter.contacted,
      },
      signals: {
        lagSeconds: currentSignals.lagSeconds,
        reconnects: currentSignals.reconnects,
        relists: currentSignals.relists,
        normalizationFailures: currentSignals.normalizationFailures,
        persistenceFailures: currentSignals.persistenceFailures,
        lastResourceVersion: currentSignals.lastResourceVersion,
        lastEventAt: currentSignals.lastEventAt,
        failedNamespaces: currentSignals.failedNamespaces,
      },
    };
  };
  const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
    const path = new URL(request.url ?? "/", "http://tracegarden.invalid").pathname;
    const correlation = telemetry.correlation();
    const requestSpan = telemetry.startSpan("http.request", correlation, {
      method: request.method ?? "GET",
      path,
    });
    response.setHeader("x-request-id", requestSpan.correlation.requestId);
    response.setHeader("x-trace-id", requestSpan.correlation.traceId);
    response.setHeader("traceparent", `00-${requestSpan.correlation.traceId}-${requestSpan.correlation.spanId}-01`);
    let responseEnded = false;
    const end = (body: string): void => {
      if (responseEnded) return;
      responseEnded = true;
      response.end(body);
    };
    void (async () => {
      if (request.method !== "GET") {
        response.statusCode = 405;
        response.setHeader("content-type", "application/json; charset=utf-8");
        end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (path === "/metrics") {
        await refreshDatabaseReadiness();
        syncCollectorMetrics();
        response.statusCode = 200;
        response.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
        end(telemetry.metricsText());
        return;
      }
      if (path !== "/health/live") await refreshDatabaseReadiness();
      const current = runtimeStatus();
      const healthy = path === "/health/live"
        ? current.liveness === "alive"
        : path === "/health/startup"
          ? current.startup === "ready"
          : current.readiness === "ready";
      response.statusCode = healthy ? 200 : 503;
      response.setHeader("content-type", "application/json; charset=utf-8");
      if (path === "/health/live") end(JSON.stringify({ service: current.service, status: current.liveness, liveness: current.liveness }));
      else if (path === "/health/startup") end(JSON.stringify({ ...current, status: current.startup === "ready" ? "ready" : "not-ready" }));
      else end(JSON.stringify(current));
    })().catch((error: unknown) => {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json; charset=utf-8");
      end(JSON.stringify({ error: "service_unavailable" }));
      telemetry.log("error", "collector.request.failure", requestSpan.correlation, { error_type: error instanceof Error ? error.name : "unknown" });
      requestSpan.fail(error);
    }).finally(() => {
      requestSpan.end({ status_code: response.statusCode });
    });
  };

  if (options.collectOnStart) {
    try {
      const startupScope = await configuredScope();
      const startupCheckpoints = startupScope
        ? await Promise.all(startupScope.namespaces.map((namespace) => checkpoint(startupScope, namespace)))
        : [];
      if (!startupScope || startupCheckpoints.some((value) => !value)) await collectObservations();
    } catch (error) {
      if (ownsDatabase) await database?.close();
      throw error;
    }
  }
  const server = createServer(requestHandler);
  const port = options.port ?? Number(environment.COLLECTOR_PORT ?? "3001");
  const host = options.host ?? environment.HOST ?? "127.0.0.1";
  try {
    await listenForStartup(server, port, host);
  } catch (error) {
    startupState = "failed";
    telemetry.log("error", "collector.startup.failure", startupCorrelation, {
      error_type: error instanceof Error ? error.name : "unknown",
    });
    if (ownsDatabase) {
      try {
        await database?.close();
      } catch {
        // Cleanup cannot mask the bind failure.
      }
    }
    throw error;
  }
  startupState = "ready";
  telemetry.log("info", "collector.started", startupCorrelation, { host, port });
  syncCollectorMetrics();
  if (retentionStore) {
    cancelRetentionCleanup = scheduleRetentionCleanup(() => {
      const run = runScheduledRetentionCleanup();
      activeRetentionCleanup = run;
      void run.finally(() => {
        if (activeRetentionCleanup === run) activeRetentionCleanup = null;
      });
    }, configuredRetentionInterval);
  }
  return {
    server,
    status: runtimeStatus,
    signals: signalSnapshot,
    telemetry,
    collect,
    collectNormalized,
    collectObservations,
    runWatch,
    close: async () => {
      stopping = true;
      telemetry.log("info", "collector.stopping", startupCorrelation);
      cancelRetentionCleanup?.();
      cancelRetentionCleanup = undefined;
      shutdownController.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await activeWatch?.catch(() => undefined);
      await activeRetentionCleanup?.catch(() => undefined);
      if (ownsDatabase) await database?.close();
    },
  };
}

if (process.argv[1]?.endsWith("/collector/src/main.js") || process.argv[1]?.endsWith("/collector/src/main.ts")) {
  let runtime: CollectorRuntime | undefined;
  let shutdownRequested = false;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): void => {
    shutdownRequested = true;
    if (!runtime || shutdownPromise) return;
    shutdownPromise = runtime.close().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Tracegarden collector failed to stop");
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    runtime = await createCollectorRuntime({ collectOnStart: true });
    if (shutdownRequested) shutdown();
    else {
      void runtime.runWatch().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : "Tracegarden collector watch failed");
        process.exitCode = 1;
      });
      console.log("Tracegarden collector initial collection completed");
      console.log(`Tracegarden collector listening on ${process.env.HOST ?? "127.0.0.1"}:${process.env.COLLECTOR_PORT ?? "3001"}`);
    }
    await shutdownPromise;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "Tracegarden collector failed to start");
    process.exitCode = 1;
  }
}
