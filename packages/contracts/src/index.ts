export type ProcessState = "ready" | "not-ready";

export type StatusResponse = Readonly<{
  service: "tracegarden-web" | "tracegarden-collector";
  status: ProcessState;
  checks: Readonly<{
    database: ProcessState;
    migrations: ProcessState;
    collector?: ProcessState;
    clusterContacted?: boolean;
  }>;
}>;

export function state(ready: boolean): ProcessState {
  return ready ? "ready" : "not-ready";
}
