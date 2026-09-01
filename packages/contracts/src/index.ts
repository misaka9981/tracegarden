export type ProcessState = "ready" | "not-ready";

export type StatusResponse = Readonly<{
  service: "tracegarden-web" | "tracegarden-collector";
  status: ProcessState;
  checks: Readonly<{
    database: ProcessState;
    migrations: ProcessState;
    timeline?: ProcessState;
    collector?: ProcessState;
    clusterContacted?: boolean;
  }>;
  signals?: Readonly<Record<string, number | string | boolean | null | readonly string[]>>;
}>;

export function state(ready: boolean): ProcessState {
  return ready ? "ready" : "not-ready";
}
