# 06: Cover supported workloads, Kubernetes Events, and Attention Items

**What to build:** Members can see normalized changes, abnormal conditions, and recoveries for every Kubernetes resource kind supported by the MVP. Review-worthy entries become Attention Items without being called incidents, alerts, root causes, or confirmed relationships.

**Blocked by:** 05: Carry one Pod Observation into the Timeline.

**Status:** resolved

- [x] Deployment, StatefulSet, DaemonSet, ReplicaSet, Pod, Job, and CronJob inputs produce the appropriate normalized Observations.
- [x] Kubernetes Events produce Observations without retaining the complete upstream object.
- [x] Workload ownership and revision facts needed for later correlation are normalized consistently.
- [x] Observable abnormal conditions become Attention Items according to domain rules.
- [x] A later recovery produces a distinct Timeline Entry so the sequence does not stop at the symptom.
- [x] UI copy and API contracts never describe an Attention Item as an incident, alert, root cause, or automatic causal link.
- [x] Deterministic tests cover at least one meaningful change, abnormal condition, and recovery partition for each supported family rather than mirroring field mappings.
- [x] All newly visible resource and Attention Item states are rendered in Simplified Chinese and English.

## Answer

Implemented supported workload and Kubernetes Event normalization, including modern `events.k8s.io/v1` and legacy Event fields with bounded projection. Attention reason codes are localized while upstream reason/message facts remain available, and abnormal classification scans all relevant conditions so condition order cannot hide a failure. Recovery classification now uses monotonic ingestion ordering in memory and PostgreSQL, including equal-timestamp batches. Job detail rendering uses entry classification rather than completion time or raw failure counts.

Focused tests cover modern and legacy Events, safe integer handling, localized attention labels, equal-time recovery in memory and PostgreSQL, non-Pod PostgreSQL persistence, and completed Jobs with failures. The PostgreSQL migration backfills `ingestion_order` using stable `observed_at`, `created_at`, and `id` ordering, then resets the sequence before applying the default.

Validation passed: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm test:browser`, `pnpm test:postgres`, and `pnpm test:container`, including Available=True/Progressing=False condition-order regressions. No files are staged. Live Kubernetes compatibility remains unverified by policy.
