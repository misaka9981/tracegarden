import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { state, type StatusResponse } from "../../../packages/contracts/src/index.js";
import {
  collectScopedResources,
  createKubernetesAdapter,
  type ClusterScope,
  type KubernetesObservationAdapter,
  type KubernetesResource,
} from "../../../packages/cluster/src/index.js";

type CollectorOptions = Readonly<{
  port?: number;
  host?: string;
  environment?: Record<string, string | undefined>;
  scope?: ClusterScope;
  adapter?: KubernetesObservationAdapter;
}>;

export type CollectorRuntime = Readonly<{
  server: Server;
  status: () => StatusResponse;
  collect: () => Promise<readonly KubernetesResource[]>;
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
  const adapter = options.adapter ?? createKubernetesAdapter(options.environment ?? process.env);
  const collect = async (): Promise<readonly KubernetesResource[]> => options.scope ? collectScopedResources(options.scope, adapter) : [];
  const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const status = collectorStatus();
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(status));
  };

  const server = createServer(requestHandler);
  const port = options.port ?? Number(process.env.COLLECTOR_PORT ?? "3001");
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return {
    server,
    status: collectorStatus,
    collect,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

if (process.argv[1]?.endsWith("/collector/src/main.js") || process.argv[1]?.endsWith("/collector/src/main.ts")) {
  try {
    await createCollectorRuntime();
    console.log(`Tracegarden collector listening on ${process.env.HOST ?? "127.0.0.1"}:${process.env.COLLECTOR_PORT ?? "3001"}`);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "Tracegarden collector failed to start");
    process.exitCode = 1;
  }
}
