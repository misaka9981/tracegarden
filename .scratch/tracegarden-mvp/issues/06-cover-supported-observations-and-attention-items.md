# 06: Cover supported workloads, Kubernetes Events, and Attention Items

**What to build:** Members can see normalized changes, abnormal conditions, and recoveries for every Kubernetes resource kind supported by the MVP. Review-worthy entries become Attention Items without being called incidents, alerts, root causes, or confirmed relationships.

**Blocked by:** 05: Carry one Pod Observation into the Timeline.

**Status:** ready-for-agent

- [ ] Deployment, StatefulSet, DaemonSet, ReplicaSet, Pod, Job, and CronJob inputs produce the appropriate normalized Observations.
- [ ] Kubernetes Events produce Observations without retaining the complete upstream object.
- [ ] Workload ownership and revision facts needed for later correlation are normalized consistently.
- [ ] Observable abnormal conditions become Attention Items according to domain rules.
- [ ] A later recovery produces a distinct Timeline Entry so the sequence does not stop at the symptom.
- [ ] UI copy and API contracts never describe an Attention Item as an incident, alert, root cause, or automatic causal link.
- [ ] Deterministic tests cover at least one meaningful change, abnormal condition, and recovery partition for each supported family rather than mirroring field mappings.
- [ ] All newly visible resource and Attention Item states are rendered in Simplified Chinese and English.
