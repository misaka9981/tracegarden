# 07: Make Cluster observation resilient and idempotent

**What to build:** The collector maintains a durable, ordered observation stream across normal Kubernetes watch failures. Members continue to receive one copy of each durable Observation after disconnects, replay, relist, and process restart, while failures remain finite and observable.

**Blocked by:** 05: Carry one Pod Observation into the Timeline.

**Status:** resolved

- [x] The collector persists an ingestion checkpoint only at the owning transactional boundary.
- [x] A restart or watch disconnect resumes from the last persisted resource version with finite, bounded backoff.
- [x] A `410 Gone` response discards the invalid watch position, performs a fresh list, persists the replacement checkpoint, and resumes watching.
- [x] Missing bookmarks do not prevent checkpoint progress or require timing sleeps in tests.
- [x] Duplicate list or watch delivery remains harmless through the durable uniqueness contract.
- [x] Normalization and persistence failures propagate to a recovery boundary and do not advance the checkpoint past uncommitted work.
- [x] Deterministic tests control delivery, disconnects, relists, backoff progression, and failures without contacting a Cluster or waiting on wall-clock sleeps.
- [x] Collector lag, reconnect, relist, normalization-failure, and persistence-failure signals are exposed for the later observability slice.

## Answer

Implemented per-namespace durable checkpoints and ordered watch coordination, streamed `410 Gone` relists, bounded namespace-scoped recovery, opaque and large resourceVersion handling, AbortSignal propagation through client requests and watch cleanup, and the pinned `@kubernetes/client-node` production adapter. Added deterministic namespace-isolation, opaque-RV, endpoint, cancellation, retry-isolation, relist, and failure-path coverage.

Validation passed: format, lint, typecheck, build, unit/resilience, PostgreSQL, container, and browser checks. No live Kubernetes Cluster, credentials, or external accounts were contacted.
