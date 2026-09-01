# 12: Request a bounded Recent Log Window

**What to build:** An owner with the log-reading Capability can inspect a bounded recent window for one Pod and container through a Kubernetes identity that is separate from observation. The response is ephemeral, audited by metadata, and absent from every persistence and telemetry surface.

**Blocked by:** 03: Manage Invitations, Members, and roles; 04: Configure one Cluster observation scope.

**Status:** ready-for-agent

- [ ] The request validates Cluster, namespace, Pod, container, and bounded tail inputs at the transport boundary.
- [ ] Only a Member with the `logs:read` Capability can request the Recent Log Window; denied requests return no log body.
- [ ] The production adapter is configured for a Kubernetes identity separate from the collector reader.
- [ ] The returned window contains no more than 200 lines or 1 MiB, with deterministic behavior when either bound is reached.
- [ ] Log bodies are never persisted, indexed, cached, analyzed, or included in audit records.
- [ ] Audit records capture only the authorized access metadata needed for accountability.
- [ ] Tests prove that log bodies are absent from database state, structured logs, traces, metrics, analytics hooks, exception messages, and error responses.
- [ ] The owner workflow and denial state are usable in Simplified Chinese and English through a fake log adapter.
