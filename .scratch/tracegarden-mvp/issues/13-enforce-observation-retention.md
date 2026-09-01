# 13: Enforce Observation retention

**What to build:** An owner can control how long ordinary Observations remain, while structured human context and confirmed relationships survive routine cleanup. The scheduled cleanup is safe to retry and reports useful counts without disclosing deleted payloads.

**Blocked by:** 10: Review Correlation Suggestions and Confirmed Links.

**Status:** resolved

- [x] Every Workspace has an ordinary Observation retention policy defaulting to 90 days.
- [x] An authorized owner can update the retention period through validated bilingual UI and API flows.
- [x] The cleanup boundary deletes eligible ordinary Observations and their unprotected Timeline state atomically.
- [x] Experiments and Timeline Entries participating in Confirmed Links are retained by ordinary cleanup.
- [x] Running cleanup repeatedly over the same eligibility window is idempotent.
- [x] Cleanup reports counts and failures without logging or emitting deleted payloads.
- [x] Controlled-time integration tests cover the cutoff boundary, protected records, partial failure recovery, and retries against disposable PostgreSQL.
- [x] A Member without the retention-management Capability cannot change policy or invoke privileged cleanup behavior.

## Answer

Implemented Observation retention policy management, atomic PostgreSQL cleanup, confirmed-link protection, capability-gated web/API flows, and scheduled collector cleanup. Observation and Experiment mutations release transaction clients before post-commit correlation refresh; durable Experiment results are materialized before commit, and refresh remains best-effort with payload-free logging. Retention default creation/read uses one atomic upsert RETURNING statement, with cleanup and all mutation transaction paths audited for committed-then-read failures. Deterministic refresh/readback failure and five-concurrent namespace/default-getter/Experiment tests cover the recovery paths.

Validation passed for formatting, lint, typecheck, build, unit/collector, PostgreSQL, and container checks. Changes remain unpushed.
