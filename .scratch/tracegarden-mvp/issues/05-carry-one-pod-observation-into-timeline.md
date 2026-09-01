# 05: Carry one Pod Observation into the Timeline

**What to build:** A deterministic Pod change travels through the separate collector process, becomes a normalized and durable Observation, and appears to a Member as a Timeline Entry. This is the first complete observation tracer bullet and establishes the transaction, identity, API, UI, and test contracts used by later resource kinds.

**Blocked by:** 04: Configure one Cluster observation scope.

**Status:** ready-for-agent

- [ ] The collector performs an initial list for Pod data within the approved Cluster scope and emits a normalized Observation.
- [ ] The Observation stores only the normalized facts needed by the product, not a complete raw Kubernetes object.
- [ ] Cluster-derived identity combines Kubernetes UID and Cluster identity.
- [ ] Observation and Timeline Entry persistence is atomic and carries Workspace and Cluster identity.
- [ ] A Member can retrieve the committed Timeline Entry through a validated, authorized API and see it in the bilingual Timeline UI.
- [ ] Re-delivery of the same source fact does not create a second Observation or Timeline Entry.
- [ ] A persistence failure creates no publishable Timeline Entry and is surfaced at the collector recovery boundary.
- [ ] An integration test proves the complete path with deterministic Kubernetes input and disposable PostgreSQL.
