export type ProcessState = "ready" | "not-ready";
export type StartupState = "starting" | "ready" | "failed";
export type LivenessState = "alive" | "stopping";

export type StatusResponse = Readonly<{
  service: "tracegarden-web" | "tracegarden-collector";
  status: ProcessState;
  startup: StartupState;
  readiness: ProcessState;
  liveness: LivenessState;
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
