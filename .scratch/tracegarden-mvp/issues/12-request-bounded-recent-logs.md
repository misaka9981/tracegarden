# 12: Request a bounded Recent Log Window

**What to build:** An owner with the log-reading Capability can inspect a bounded recent window for one Pod and container through a Kubernetes identity that is separate from observation. The response is ephemeral, audited by metadata, and absent from every persistence and telemetry surface.

**Blocked by:** 03: Manage Invitations, Members, and roles; 04: Configure one Cluster observation scope.

**Status:** resolved

- [x] The request validates Cluster, namespace, Pod, container, and bounded tail inputs at the transport boundary.
- [x] Only a Member with the `logs:read` Capability can request the Recent Log Window; denied requests return no log body.
- [x] The production adapter is configured for a Kubernetes identity separate from the collector reader.
- [x] The returned window contains no more than 200 lines or 1 MiB, with deterministic behavior when either bound is reached.
- [x] Log bodies are never persisted, indexed, cached, analyzed, or included in audit records.
- [x] Audit records capture only the authorized access metadata needed for accountability.
- [x] Tests prove that log bodies are absent from database state, structured logs, traces, metrics, analytics hooks, exception messages, and error responses.
- [x] The owner workflow and denial state are usable in Simplified Chinese and English through a fake log adapter.

## Answer

Implemented the bounded Recent Log Window through the owner-only `logs:read` Capability. Transport and scope validation cover Cluster, namespace, Pod, container, and tail; the Kubernetes log adapter uses separate `KUBERNETES_LOG_API_SERVER` and `KUBERNETES_LOG_TOKEN` settings and bounded streaming. Responses are capped at 200 lines or 1 MiB, marked `Cache-Control: no-store`, and returned only ephemerally.

Audit persistence records only access metadata (`Cluster`, namespace, Pod, container, tail, and result size) through the immutable audit table. Log bodies are excluded from database state, audit records, structured logs, traces, metrics, analytics hooks, exception messages, and API/HTML errors. Simplified Chinese and English owner/denial workflows use the fake adapter in deterministic tests.

Validation passed: `CI=true pnpm format:check`, `CI=true pnpm lint`, `CI=true pnpm typecheck`, `CI=true pnpm build`, `CI=true pnpm test`, `CI=true pnpm test:browser`, `CI=true pnpm test:postgres`, and `git diff --check`. Its audit/capability migration is ordered as `0007_recent_logs`, after ticket 05's `0006_observation_timeline` migration.

Live Kubernetes log integration, production cluster compatibility, and external identity integration remain unverified by policy; no external or ambient Kubernetes service was contacted.
