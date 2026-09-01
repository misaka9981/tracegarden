# 10: Review Correlation Suggestions and Confirmed Links

**What to build:** Tracegarden proposes reviewable relationships between changes, symptoms, and Experiments, while Members retain final judgment. A Member can confirm or reject a Correlation Suggestion, and only confirmation creates a durable Confirmed Link attributed to that Member.

**Blocked by:** 06: Cover supported workloads, Kubernetes Events, and Attention Items; 09: Record structured Experiments.

**Status:** resolved

- [x] Defined time, workload ownership, label, or revision signals can produce a Correlation Suggestion between eligible Timeline Entries.
- [x] A Correlation Suggestion is visibly and contractually distinct from a Confirmed Link.
- [x] Product copy never describes an unconfirmed suggestion as cause or root cause.
- [x] An authorized Member can confirm a suggestion exactly once, creating a durable Confirmed Link attributed to the confirming Member.
- [x] An authorized Member can reject a suggestion so that it no longer appears as pending review.
- [x] Concurrent or repeated decisions resolve idempotently under one owning transaction.
- [x] Experiments and Timeline Entries participating in Confirmed Links expose the durable relationship when revisited.
- [x] Domain, repository, API, and Playwright tests cover proposal, confirmation, rejection, authorization, and persisted reconstruction in both languages.

## Answer

Implemented correlation suggestions and Confirmed Links across the domain, PostgreSQL and memory stores, API, and bilingual UI. Production rejects injected Experiment/Timeline stores in favor of database-owned stores. Playwright covers confirmation, successful rejection of pending suggestions in Chinese and English, unauthorized/denied review, conflict handling, pending removal, and persisted rejected status.
