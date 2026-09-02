# 22: Prove live Kubernetes compatibility and RBAC on the authorized kind Cluster

**What to build:** Tracegarden runs in isolated namespaces on the VM's existing `k8s-cluster-v137` kind Cluster and demonstrates real list/watch, checkpoint recovery, bounded logs, and least-privilege RBAC.

**Blocked by:** 21: Prove the ARM64 VM runtime baseline.

**Status:** ready-for-agent

- [ ] Every Kubernetes command is executed over SSH on the VM, names the authorized kind context explicitly, and stops if the current context is not the Cluster backed by `k8s-cluster-v137-control-plane` and `k8s-cluster-v137-worker`.
- [ ] Cluster version and node architecture are recorded; no other context, Cluster, Secret, ConfigMap value, or unrelated namespace is enumerated.
- [ ] Tracegarden is installed only in uniquely labelled `tracegarden-live-*` namespaces and reaches migration, PostgreSQL, web, and collector readiness without using port 443.
- [ ] A labelled fixture Deployment and Pod produce initial-list and subsequent-watch Observations and Timeline Entries exactly once.
- [ ] Collector restart resumes durable checkpoints; a supported relist/expired-resource-version exercise recovers without duplicate Timeline Entries.
- [ ] The observation identity can read only approved resource kinds and cannot read Secrets, Pod logs, or mutate workloads.
- [ ] The separate log identity can read only bounded Pod logs and cannot read Secrets or mutate workloads.
- [ ] All test resources are deleted by run label; existing kind workloads and Caddy remain unchanged.

## Safe stop rules

Stop before mutation if the context identity is ambiguous, if matching Tracegarden namespaces pre-exist without the run label, or if required RBAC would grant cluster-admin. Never alter existing workloads or inspect Secret/ConfigMap contents.
