# 14: Expose safe operational health and telemetry

**What to build:** Operators can determine whether Tracegarden is starting, ready, healthy, ingesting, streaming, and persisting correctly without exposing protected content. Telemetry exporters remain optional, and their failure cannot stop core web or collector behavior.

**Blocked by:** 07: Make Cluster observation resilient and idempotent; 11: Deliver live Timeline updates with cursor recovery; 12: Request a bounded Recent Log Window; 13: Enforce Observation retention.

**Status:** resolved

- [x] Web and collector expose distinct startup, readiness, and conservative liveness states with observable transition rules.
- [x] Structured logs, OpenTelemetry traces, and Prometheus-compatible metrics share correlation metadata without including protected values.
- [x] Metrics cover collector lag, reconnects, relists, normalization and persistence failures, SSE clients, cursor lag, database pool state, and migration status.
- [x] Missing, unreachable, or failing telemetry exporters do not prevent startup, ingestion, Timeline requests, or Recent Log Window requests.
- [x] Recent Log Window bodies and other protected content remain absent from normal, failure, and exception telemetry paths.
- [x] Health checks distinguish dependency readiness from liveness so a transient external failure does not create an unsafe restart loop.
- [x] Automated tests inject exporter and dependency failures and assert observable health and core-behavior outcomes without inspecting private instrumentation wiring.
- [x] Operational documentation describes each signal's observable meaning and leaves full monitoring-stack installation outside the product.

## Answer

Implemented safe operational health and telemetry across web, collector, database, logs, and Timeline SSE boundaries. Health checks now separate startup, dependency readiness, and liveness; database loss, migration state, Kubernetes preconditions, and PostgreSQL LISTEN failures are reflected conservatively. SSE subscriptions complete before a `200` response, exporter and Recent Log telemetry callback failures are isolated, request IDs and traceparent values are server-generated, protected request/log content is redacted, and metric series are bounded. Web and collector startup binds use one-shot `error`/`listening` handlers with cleanup and failure telemetry, and deterministic occupied-port tests cover both services.

Validation passed with `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm test:browser`, `pnpm test:postgres`, and `pnpm test:container`. `pnpm env:check` remains unavailable in this environment because Node `v24.14.0` is installed while the repository requires Node `26.8.x`.
