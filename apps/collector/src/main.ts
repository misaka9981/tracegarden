import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { state, type StatusResponse } from "../../../packages/contracts/src/index.js";
import {
  collectScopedResources,
  createKubernetesAdapter,
  normalizeObservation,
  type ClusterScope,
  type KubernetesObservationAdapter,
  type KubernetesResource,
  type NormalizedObservation,
} from "../../../packages/cluster/src/index.js";
import { createDatabase, type DatabaseBoundary, type ObservationPersistenceResult, type TimelineStore } from "../../../packages/db/src/index.js";
import { WORKSPACE_ID } from "../../../packages/identity/src/index.js";

export type CollectorOptions = Readonly<{
  port?: number;
  host?: string;
  environment?: Record<string, string | undefined>;
  scope?: ClusterScope;
  adapter?: KubernetesObservationAdapter;
  database?: DatabaseBoundary;
  observationStore?: TimelineStore;
  collectOnStart?: boolean;
}>;

export class CollectorRecoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CollectorRecoveryError";
  }
}

export type CollectorRuntime = Readonly<{
  server: Server;
  status: () => StatusResponse;
  collect: () => Promise<readonly KubernetesResource[]>;
  collectNormalized: () => Promise<readonly NormalizedObservation[]>;
  collectObservations: () => Promise<readonly ObservationPersistenceResult[]>;
  close: () => Promise<void>;
}>;

export function collectorStatus(): StatusResponse {
  return {
    service: "tracegarden-collector",
    status: state(true),
    checks: {
      database: "not-ready",
      migrations: "not-ready",
      collector: "ready",
      clusterContacted: false,
    },
  };
}

export async function createCollectorRuntime(options: CollectorOptions = {}): Promise<CollectorRuntime> {
  const environment = options.environment ?? process.env;
  const adapter = options.adapter ?? createKubernetesAdapter(environment);
  const ownsDatabase = !options.database && !options.observationStore && Boolean(environment.DATABASE_URL);
  const database = options.database ?? (ownsDatabase ? createDatabase(environment) : undefined);
  const observationStore = options.observationStore ?? database?.timeline;
  if (database) {
    try {
      await database.migrate();
      if (!(await database.ping())) throw new Error("Tracegarden collector database readiness check failed");
    } catch (error) {
      if (ownsDatabase) await database.close();
      throw error;
    }
  }
  const configuredScope = async (): Promise<ClusterScope | null> => options.scope ?? await database?.clusterScope?.get(WORKSPACE_ID) ?? null;
  const collect = async (): Promise<readonly KubernetesResource[]> => {
    const scope = await configuredScope();
    return scope ? collectScopedResources(scope, adapter) : [];
  };
  const collectNormalized = async (): Promise<readonly NormalizedObservation[]> => {
    const scope = await configuredScope();
    if (!scope) return [];
    const resources = await collectScopedResources(scope, adapter);
    return resources.map((resource) => normalizeObservation(scope, resource));
  };
  const collectObservations = async (): Promise<readonly ObservationPersistenceResult[]> => {
    if (!observationStore) throw new CollectorRecoveryError("Collector recovery boundary: observation persistence is unavailable");
    try {
      const normalized = await collectNormalized();
      if (observationStore.recordObservations) return await observationStore.recordObservations(normalized);
      if (options.collectOnStart) throw new Error("Atomic observation batch persistence is required during collector startup");
      const persisted: ObservationPersistenceResult[] = [];
      for (const observation of normalized) persisted.push(await observationStore.recordObservation(observation));
      return persisted;
    } catch (error) {
      if (error instanceof CollectorRecoveryError) throw error;
      throw new CollectorRecoveryError("Collector recovery boundary: observation persistence failed", { cause: error });
    }
  };
  const runtimeStatus = (): StatusResponse => {
    const base = collectorStatus();
    return {
      ...base,
      checks: {
        ...base.checks,
        database: database ? "ready" : "not-ready",
        migrations: database ? "ready" : "not-ready",
        clusterContacted: adapter.contacted,
      },
    };
  };
  const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const status = runtimeStatus();
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(status));
  };

  if (options.collectOnStart) {
    try {
      await collectObservations();
    } catch (error) {
      if (ownsDatabase) await database?.close();
      throw error;
    }
  }
  const server = createServer(requestHandler);
  const port = options.port ?? Number(environment.COLLECTOR_PORT ?? "3001");
  const host = options.host ?? environment.HOST ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return {
    server,
    status: runtimeStatus,
    collect,
    collectNormalized,
    collectObservations,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ownsDatabase) await database?.close();
    },
  };
}

if (process.argv[1]?.endsWith("/collector/src/main.js") || process.argv[1]?.endsWith("/collector/src/main.ts")) {
  try {
    await createCollectorRuntime({ collectOnStart: true });
    console.log("Tracegarden collector initial collection completed");
    console.log(`Tracegarden collector listening on ${process.env.HOST ?? "127.0.0.1"}:${process.env.COLLECTOR_PORT ?? "3001"}`);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "Tracegarden collector failed to start");
    process.exitCode = 1;
  }
}
