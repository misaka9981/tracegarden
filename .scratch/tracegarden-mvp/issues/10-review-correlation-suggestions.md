# 10: Review Correlation Suggestions and Confirmed Links

**What to build:** Tracegarden proposes reviewable relationships between changes, symptoms, and Experiments, while Members retain final judgment. A Member can confirm or reject a Correlation Suggestion, and only confirmation creates a durable Confirmed Link attributed to that Member.

**Blocked by:** 06: Cover supported workloads, Kubernetes Events, and Attention Items; 09: Record structured Experiments.

**Status:** ready-for-agent

- [ ] Defined time, workload ownership, label, or revision signals can produce a Correlation Suggestion between eligible Timeline Entries.
- [ ] A Correlation Suggestion is visibly and contractually distinct from a Confirmed Link.
- [ ] Product copy never describes an unconfirmed suggestion as cause or root cause.
- [ ] An authorized Member can confirm a suggestion exactly once, creating a durable Confirmed Link attributed to the confirming Member.
- [ ] An authorized Member can reject a suggestion so that it no longer appears as pending review.
- [ ] Concurrent or repeated decisions resolve idempotently under one owning transaction.
- [ ] Experiments and Timeline Entries participating in Confirmed Links expose the durable relationship when revisited.
- [ ] Domain, repository, API, and Playwright tests cover proposal, confirmation, rejection, authorization, and persisted reconstruction in both languages.
