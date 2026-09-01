# 04: Configure one Cluster observation scope

**What to build:** An owner can configure the single Cluster exposed by the MVP and explicitly approve the namespaces and resource kinds Tracegarden may observe. The deterministic Kubernetes adapter demonstrates the scope without contacting a real Cluster or any existing company context.

**Blocked by:** 02: Bootstrap Workspace admission.

**Status:** ready-for-agent

- [ ] An owner can create and update the one Cluster connection exposed by the initial UI.
- [ ] Cluster identity and approved namespace/resource scope are persisted with Workspace identity.
- [ ] Configuration validates namespace and supported resource-kind inputs at the transport boundary.
- [ ] A Member without the Cluster-configuration Capability cannot change the observation scope.
- [ ] The collector receives an explicit Cluster identity and approved scope rather than reading an ambient current context.
- [ ] Deterministic adapter tests prove that objects outside the approved namespace or resource scope are not observed.
- [ ] Production Kubernetes configuration remains inert when required settings are absent and no test contacts a live Cluster.
- [ ] The configuration and denial workflows are available in Simplified Chinese and English.
