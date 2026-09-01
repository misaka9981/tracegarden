# 05: Carry one Pod Observation into the Timeline

**What to build:** A deterministic Pod change travels through the separate collector process, becomes a normalized and durable Observation, and appears to a Member as a Timeline Entry. This is the first complete observation tracer bullet and establishes the transaction, identity, API, UI, and test contracts used by later resource kinds.

**Blocked by:** 04: Configure one Cluster observation scope.

**Status:** resolved

- [x] The collector performs an initial list for Pod data within the approved Cluster scope and emits a normalized Observation.
- [x] The Observation stores only the normalized facts needed by the product, not a complete raw Kubernetes object.
- [x] Cluster-derived identity combines Kubernetes UID and Cluster identity.
- [x] Observation and Timeline Entry persistence is atomic and carries Workspace and Cluster identity.
- [x] A Member can retrieve the committed Timeline Entry through a validated, authorized API and see it in the bilingual Timeline UI.
- [x] Re-delivery of the same source fact does not create a second Observation or Timeline Entry.
- [x] A persistence failure creates no publishable Timeline Entry and is surfaced at the collector recovery boundary.
- [x] An integration test proves the complete path with deterministic Kubernetes input and disposable PostgreSQL.

## Answer

Implemented the Pod tracer bullet across the independent collector and web processes. The collector performs a durable initial scoped list before listening, projects bounded Pod facts, and uses Cluster endpoint/UID identity. PostgreSQL stores Observation and Timeline Entry rows atomically with Workspace and Cluster identity, source-key idempotency, and rollback on failure. Members retrieve entries through a capability-authorized, validated Timeline API and bilingual UI.

Evidence: `scripts/test.mjs` covers deterministic normalization, configured endpoint use, startup ordering/failure, authorization, and deduplication. `scripts/postgres-smoke.mjs` applies the disposable PostgreSQL migrations, spawns the collector process, proves the complete deterministic Pod-to-Timeline path, duplicate delivery, rollback after the Observation write, and bilingual API/UI retrieval. `CI=1 pnpm format:check`, `CI=1 pnpm lint`, `CI=1 pnpm typecheck`, `CI=1 pnpm build`, `node scripts/test.mjs`, `node scripts/postgres-smoke.mjs`, `CI=1 pnpm test:browser`, and `CI=1 pnpm test:container` pass. No files are staged.

Live Kubernetes compatibility, real OAuth callbacks, cloud services, and production infrastructure remain unverified by policy; no external system or live Cluster was contacted.
