# 07: Run migrations on Bun

**What to build:** Make the one-shot migration process run on the pinned Bun runtime while preserving PostgreSQL serialization and rollout gating.

**Blocked by:** 04: Prove Bun runtime compatibility.

**Status:** resolved

- [x] Migration discovery, ordering, advisory locking, transaction rollback, schema verification, readiness deadlines, and error cleanup retain parity.
- [x] Fresh install, upgrade, concurrent invocation, failed migration, and retry paths are exercised against disposable PostgreSQL.
- [x] The migration image is immutable, non-root, read-only, capability-dropped, ARM64-compatible, and contains no unnecessary Node runtime.
- [x] Helm ordering and schema-wait behavior remain fail-closed.
- [x] PostgreSQL, container, chart, ARM64 VM, and authorized kind checks pass.

## Answer

Validated the migration-only Bun runtime cutover from exact tested source commit `c7b46b3c79dcd4b25396f82d70b2c0950bc0bf6b` on the authorized ARM64 VM and exact kind context `kind-k8s-cluster-v137`. The bounded Bun migration smoke passed fresh install, upgrade, concurrent advisory-lock execution, transactional failure rollback, and retry; the production migration image proved ARM64, non-root/read-only execution and both `/usr/local/bin/node` absence and `command -v node` failure. The direct kind Jobs passed and the database reported `15:15`. Evidence: [`evidence/07-bun-migrations/report.md`](../../../evidence/07-bun-migrations/report.md). The final amended `HEAD` contains only this issue, its evidence report, and its sanitized transcript beyond tested source commit `c7b46b3c79dcd4b25396f82d70b2c0950bc0bf6b`; `git diff-tree --no-commit-id --name-only -r` records exactly those three metadata paths. No runtime-bearing source was changed after the tested validation. Web, collector, and backup are outside this ticket's scope.

## Safe stop rules

Do not rewrite migrations, change PostgreSQL versions, or relax rollout gates to accommodate Bun.
