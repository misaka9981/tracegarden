# 22: Prove live Kubernetes compatibility and RBAC on the authorized kind Cluster

**What to build:** Tracegarden runs in isolated namespaces on the VM's existing `k8s-cluster-v137` kind Cluster and demonstrates real list/watch, checkpoint recovery, bounded logs, and least-privilege RBAC.

**Blocked by:** 21: Prove the ARM64 VM runtime baseline.

**Status:** resolved

- [x] Every Kubernetes command is executed over SSH on the VM, names the authorized kind context explicitly, and stops if the current context is not the Cluster backed by `k8s-cluster-v137-control-plane` and `k8s-cluster-v137-worker`.
- [x] Cluster version and node architecture are recorded; no other context, Cluster, Secret, ConfigMap value, or unrelated namespace is enumerated.
- [x] Tracegarden is installed only in uniquely labelled `tracegarden-live-*` namespaces and reaches migration, PostgreSQL, web, and collector readiness without using an application listener on port 443.
- [x] A labelled fixture Deployment and Pod produce initial-list and subsequent-watch Observations and Timeline Entries exactly once.
- [x] Collector restart resumes durable checkpoints; a supported relist/expired-resource-version exercise recovers without duplicate Timeline Entries.
- [x] The observation identity can read only approved resource kinds and cannot read Secrets, Pod logs, or mutate workloads.
- [x] The separate log identity can read only bounded Pod logs and cannot read Secrets or mutate workloads.
- [x] All test resources are deleted by run label; existing kind workloads and Caddy remain unchanged.

## Safe stop rules

Stop before mutation if the context identity is ambiguous, if matching Tracegarden namespaces pre-exist without the run label, or if required RBAC would grant cluster-admin. Never alter existing workloads or inspect Secret/ConfigMap contents.

## Answer

Resolved using profile `kind-host-network-apiserver-validation`. The bounded run evidence in [evidence/22-kind-kubernetes/report.md](../../../evidence/22-kind-kubernetes/report.md) proves the application path and RBAC boundary: the run reached migration, PostgreSQL, web, and collector readiness; a labelled fixture produced list/watch Observations and Timeline Entries without duplicate source identities; collector restart and stale-resource-version recovery restored checkpoints without duplicate entries; the observation identity was denied Secrets, Pod logs, and workload mutation; and the separate logs-reader identity fetched only a bounded Pod-log tail. The run was isolated, used no application listener on port 443, and cleanup removed only run-labelled resources while preserving Caddy and the existing kind containers.

This resolution does not claim NetworkPolicy portability. The kind CNI blocked the collector's host-network kube-apiserver path under the narrow endpoint rules exercised. The production NetworkPolicy defaults remain mandatory and unchanged: no policy file was weakened, no disable switch was added, and no broad rule was committed. The evidence records the exact run-only characterization probes and the temporary collector-policy exception used for the remaining authorized application/RBAC checks, including restoration and cleanup. Proving the same narrow collector/web API egress with the named production CNI is a separate non-blocking needs-info follow-up in issue 29.
