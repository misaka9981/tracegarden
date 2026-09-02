# 06: Run the collector process on Bun

**What to build:** Make Bun the production runtime for the collector without changing observation or checkpoint semantics.

**Blocked by:** 04: Prove Bun runtime compatibility.

**Status:** ready-for-agent

- [ ] Collector startup, migration/readiness verification, Kubernetes list/watch, bounded buffering, cancellation, reconnect, relist, checkpoint persistence, and telemetry retain parity.
- [ ] `@kubernetes/client-node`, PostgreSQL transactions, timeout/abort behavior, and signal shutdown are exercised under Bun.
- [ ] The production collector image is immutable, non-root, read-only, capability-dropped, ARM64-compatible, and contains no unnecessary Node runtime.
- [ ] Deterministic collector resilience, PostgreSQL integration, container, chart, ARM64 VM, and authorized kind checks pass.
- [ ] No duplicate Observation, stale-scope persistence, leaked watch, or retry-budget regression is introduced.

## Safe stop rules

Do not combine this with web, migration, backup, database-driver, or Cluster permission changes.
