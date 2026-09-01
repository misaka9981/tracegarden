# 13: Enforce Observation retention

**What to build:** An owner can control how long ordinary Observations remain, while structured human context and confirmed relationships survive routine cleanup. The scheduled cleanup is safe to retry and reports useful counts without disclosing deleted payloads.

**Blocked by:** 10: Review Correlation Suggestions and Confirmed Links.

**Status:** ready-for-agent

- [ ] Every Workspace has an ordinary Observation retention policy defaulting to 90 days.
- [ ] An authorized owner can update the retention period through validated bilingual UI and API flows.
- [ ] The cleanup boundary deletes eligible ordinary Observations and their unprotected Timeline state atomically.
- [ ] Experiments and Timeline Entries participating in Confirmed Links are retained by ordinary cleanup.
- [ ] Running cleanup repeatedly over the same eligibility window is idempotent.
- [ ] Cleanup reports counts and failures without logging or emitting deleted payloads.
- [ ] Controlled-time integration tests cover the cutoff boundary, protected records, partial failure recovery, and retries against disposable PostgreSQL.
- [ ] A Member without the retention-management Capability cannot change policy or invoke privileged cleanup behavior.
