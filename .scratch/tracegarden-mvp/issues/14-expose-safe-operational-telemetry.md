# 14: Expose safe operational health and telemetry

**What to build:** Operators can determine whether Tracegarden is starting, ready, healthy, ingesting, streaming, and persisting correctly without exposing protected content. Telemetry exporters remain optional, and their failure cannot stop core web or collector behavior.

**Blocked by:** 07: Make Cluster observation resilient and idempotent; 11: Deliver live Timeline updates with cursor recovery; 12: Request a bounded Recent Log Window; 13: Enforce Observation retention.

**Status:** ready-for-agent

- [ ] Web and collector expose distinct startup, readiness, and conservative liveness states with observable transition rules.
- [ ] Structured logs, OpenTelemetry traces, and Prometheus-compatible metrics share correlation metadata without including protected values.
- [ ] Metrics cover collector lag, reconnects, relists, normalization and persistence failures, SSE clients, cursor lag, database pool state, and migration status.
- [ ] Missing, unreachable, or failing telemetry exporters do not prevent startup, ingestion, Timeline requests, or Recent Log Window requests.
- [ ] Recent Log Window bodies and other protected content remain absent from normal, failure, and exception telemetry paths.
- [ ] Health checks distinguish dependency readiness from liveness so a transient external failure does not create an unsafe restart loop.
- [ ] Automated tests inject exporter and dependency failures and assert observable health and core-behavior outcomes without inspecting private instrumentation wiring.
- [ ] Operational documentation describes each signal's observable meaning and leaves full monitoring-stack installation outside the product.
