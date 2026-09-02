# 07: Run migrations on Bun

**What to build:** Make the one-shot migration process run on the pinned Bun runtime while preserving PostgreSQL serialization and rollout gating.

**Blocked by:** 04: Prove Bun runtime compatibility.

**Status:** ready-for-agent

- [ ] Migration discovery, ordering, advisory locking, transaction rollback, schema verification, readiness deadlines, and error cleanup retain parity.
- [ ] Fresh install, upgrade, concurrent invocation, failed migration, and retry paths are exercised against disposable PostgreSQL.
- [ ] The migration image is immutable, non-root, read-only, capability-dropped, ARM64-compatible, and contains no unnecessary Node runtime.
- [ ] Helm ordering and schema-wait behavior remain fail-closed.
- [ ] PostgreSQL, container, chart, ARM64 VM, and authorized kind checks pass.

## Safe stop rules

Do not rewrite migrations, change PostgreSQL versions, or relax rollout gates to accommodate Bun.
