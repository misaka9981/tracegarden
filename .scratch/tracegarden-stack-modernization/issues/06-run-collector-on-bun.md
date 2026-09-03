# 06: Run the collector process on Bun

**What to build:** Make Bun the production runtime for the collector without changing observation or checkpoint semantics.

**Blocked by:** 04: Prove Bun runtime compatibility.

**Status:** resolved

- [x] Collector startup, migration/readiness verification, Kubernetes list/watch, bounded buffering, cancellation, reconnect, relist, checkpoint persistence, and telemetry retain parity.
- [x] `@kubernetes/client-node`, PostgreSQL transactions, timeout/abort behavior, and signal shutdown are exercised under Bun.
- [x] The production collector image is immutable, non-root, read-only, capability-dropped, ARM64-compatible, and contains no unnecessary Node runtime.
- [x] Deterministic collector resilience, PostgreSQL integration, container, chart, ARM64 VM, and authorized kind checks pass.
- [x] No duplicate Observation, stale-scope persistence, leaked watch, or retry-budget regression is introduced.

## Answer

Resolved with the bounded evidence in [evidence/06-collector-bun/report.md](../../../evidence/06-collector-bun/report.md). The collector alone now uses the exact ARM64 Bun 1.3.14 image and entrypoint, and the Bun gate runs the deterministic collector-resilience suite before the broader compatibility harness. Ticket 05 separately covers the web. This ticket left migration and backup out of scope; Tickets 07 and 08 later moved those processes to Bun independently. PostgreSQL, `pg`, pnpm, TypeScript, Node Playwright, and Cluster permissions remain unchanged. The authorized ARM64 VM acceptance and isolated kind smoke passed, including cleanup and preservation of the existing Caddy/kind containers. Production external integrations remain outside this ticket.

## Safe stop rules

Do not combine this with web, migration, backup, database-driver, or Cluster permission changes.
