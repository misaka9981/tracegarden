# 15: Run migrations and production processes as non-root

**What to build:** Maintainers can build and run production web and collector images with minimal privileges, predictable configuration, and a migration gate that prevents incompatible rollout. Container behavior is verifiable locally without credentials or a live Cluster.

**Blocked by:** 14: Expose safe operational health and telemetry.

**Status:** ready-for-agent

- [ ] Production web and collector images build reproducibly for the supported local architecture from the frozen dependency graph.
- [ ] Both application processes run as a non-root user with a read-only application filesystem except for explicitly required ephemeral locations.
- [ ] Images contain only production runtime requirements and do not embed source credentials, local configuration, or development-only services.
- [ ] A one-shot migration process applies pending migrations before application rollout.
- [ ] Migration failure is required and blocks web and collector readiness rather than being treated as best-effort.
- [ ] Container smoke tests exercise startup, readiness, conservative liveness, graceful shutdown, invalid configuration, and migration ordering.
- [ ] Collector smoke tests remain credential-free and do not contact a Kubernetes context.
- [ ] Image and process telemetry preserve the protected-content rules established by the operational slice.
