# 16: Render the production Kubernetes deployment safely

**What to build:** Maintainers can render and schema-validate a complete production deployment for Tracegarden without contacting a Cluster. The declared topology separates process and Kubernetes identities, enforces resource and network boundaries, and orders migrations before application readiness.

**Blocked by:** 15: Run migrations and production processes as non-root.

**Status:** resolved

- [x] The chart renders separate web and collector workloads, PostgreSQL persistence, a one-shot migration Job, Services, Ingress, and operational probes.
- [x] Workloads declare non-root security contexts, resource requests and limits, and explicit configuration inputs.
- [x] Observation and Recent Log Window use separate ServiceAccounts and least-privilege RBAC.
- [x] Collector RBAC is limited to get, list, and watch for approved resource kinds and excludes Secrets, ConfigMap values, logs, exec, port-forward, and writes.
- [x] The log identity receives only the bounded Pod-log permission needed by the Recent Log Window and no workload write permission.
- [x] NetworkPolicies express the required web, collector, PostgreSQL, ingress, and control-plane communication paths without assuming an unrestricted namespace.
- [x] Migration ordering prevents application rollout against an old schema.
- [x] Rendering and Kubernetes schema validation pass offline with immutable image references and no access to any configured Cluster.

## Answer

Implemented the production chart and runtime migration ordering fixes. The default PostgreSQL CPU quantity is schema-valid, PostgreSQL, migration, and application resources carry Argo sync waves, and one regular revision-named migration Job waits for database readiness with bounded timeout/retry settings. Web and collector initContainers wait only for the expected schema, while startup verification remains a second gate; migration failures remain blocking.

Fresh-install, upgrade-revision, failure-gate, and Kubernetes schema renders pass offline with Helm and kubeconform. `pnpm test:chart` passed all three scenarios; `pnpm chart:render` passed; and `pnpm chart:validate` reported 19 valid resources with zero invalid, error, or skipped resources. Build, typecheck, format, lint, unit, PostgreSQL, browser, and ARM64 container checks also pass. No Cluster or external account was contacted.
