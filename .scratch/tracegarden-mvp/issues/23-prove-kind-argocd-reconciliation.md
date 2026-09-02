# 23: Prove Argo CD reconciliation and Preview Environment cleanup on kind

**What to build:** A disposable Argo CD installation on the authorized kind Cluster pulls trusted desired state, reconciles a Preview Environment, and removes it after draft/close/orphan transitions.

**Blocked by:** 22: Prove live Kubernetes compatibility and RBAC on the authorized kind Cluster.

**Status:** ready-for-agent

- [ ] The test first proves no existing Argo CD installation or conflicting CRDs are owned by another workload; otherwise it stops without changes.
- [ ] Argo CD and its CRDs are installed from the repository-pinned declarations into uniquely labelled disposable namespaces with no public ingress.
- [ ] A trusted, disposable Git source supplies the fixed Preview chart and operator-approved digest values; pull-request-controlled source cannot replace authentication or image declarations.
- [ ] Argo CD reports Synced/Healthy for the expected revision and exact local image digests.
- [ ] Preview admission enforces aggregate count/CPU/memory/pod limits and production reservation before eligibility.
- [ ] Draft, close, and missed-event orphan reconciliation remove only the labelled Preview Application and namespace within the documented bound.
- [ ] CI credentials and cluster-admin credentials are not introduced; evidence contains no repository token or Kubernetes token.
- [ ] All Argo CD, Git source, Preview, and CRD resources created by this run are removed without touching pre-existing resources.

## Safe stop rules

Stop if Argo CD or matching CRDs already exist without the run label, if a trusted Git source requires undisclosed credentials, or if cleanup cannot be scoped by run label. Do not expose Argo CD externally or grant CI a kubeconfig.
