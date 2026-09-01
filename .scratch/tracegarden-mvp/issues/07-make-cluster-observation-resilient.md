# 07: Make Cluster observation resilient and idempotent

**What to build:** The collector maintains a durable, ordered observation stream across normal Kubernetes watch failures. Members continue to receive one copy of each durable Observation after disconnects, replay, relist, and process restart, while failures remain finite and observable.

**Blocked by:** 05: Carry one Pod Observation into the Timeline.

**Status:** ready-for-agent

- [ ] The collector persists an ingestion checkpoint only at the owning transactional boundary.
- [ ] A restart or watch disconnect resumes from the last persisted resource version with finite, bounded backoff.
- [ ] A `410 Gone` response discards the invalid watch position, performs a fresh list, persists the replacement checkpoint, and resumes watching.
- [ ] Missing bookmarks do not prevent checkpoint progress or require timing sleeps in tests.
- [ ] Duplicate list or watch delivery remains harmless through the durable uniqueness contract.
- [ ] Normalization and persistence failures propagate to a recovery boundary and do not advance the checkpoint past uncommitted work.
- [ ] Deterministic tests control delivery, disconnects, relists, backoff progression, and failures without contacting a Cluster or waiting on wall-clock sleeps.
- [ ] Collector lag, reconnect, relist, normalization-failure, and persistence-failure signals are exposed for the later observability slice.
