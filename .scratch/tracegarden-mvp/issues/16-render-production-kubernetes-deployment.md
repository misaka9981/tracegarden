# 16: Render the production Kubernetes deployment safely

**What to build:** Maintainers can render and schema-validate a complete production deployment for Tracegarden without contacting a Cluster. The declared topology separates process and Kubernetes identities, enforces resource and network boundaries, and orders migrations before application readiness.

**Blocked by:** 15: Run migrations and production processes as non-root.

**Status:** ready-for-agent

- [ ] The chart renders separate web and collector workloads, PostgreSQL persistence, a one-shot migration Job, Services, Ingress, and operational probes.
- [ ] Workloads declare non-root security contexts, resource requests and limits, and explicit configuration inputs.
- [ ] Observation and Recent Log Window use separate ServiceAccounts and least-privilege RBAC.
- [ ] Collector RBAC is limited to get, list, and watch for approved resource kinds and excludes Secrets, ConfigMap values, logs, exec, port-forward, and writes.
- [ ] The log identity receives only the bounded Pod-log permission needed by the Recent Log Window and no workload write permission.
- [ ] NetworkPolicies express the required web, collector, PostgreSQL, ingress, and control-plane communication paths without assuming an unrestricted namespace.
- [ ] Migration ordering prevents application rollout against an old schema.
- [ ] Rendering and Kubernetes schema validation pass offline with immutable image references and no access to any configured Cluster.
