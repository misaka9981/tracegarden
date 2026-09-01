# 04: Configure one Cluster observation scope

**What to build:** An owner can configure the single Cluster exposed by the MVP and explicitly approve the namespaces and resource kinds Tracegarden may observe. The deterministic Kubernetes adapter demonstrates the scope without contacting a real Cluster or any existing company context.

**Blocked by:** 02: Bootstrap Workspace admission.

**Status:** resolved

- [x] An owner can create and update the one Cluster connection exposed by the initial UI.
- [x] Cluster identity and approved namespace/resource scope are persisted with Workspace identity.
- [x] Configuration validates namespace and supported resource-kind inputs at the transport boundary.
- [x] A Member without the Cluster-configuration Capability cannot change the observation scope.
- [x] The collector receives an explicit Cluster identity and approved scope rather than reading an ambient current context.
- [x] Deterministic adapter tests prove that objects outside the approved namespace or resource scope are not observed.
- [x] Production Kubernetes configuration remains inert when required settings are absent and no test contacts a live Cluster.
- [x] The configuration and denial workflows are available in Simplified Chinese and English.

## Answer

Implemented one-Cluster observation scope configuration with owner-only `cluster:configure` authorization, transport-bound namespace/resource-kind validation, Workspace-scoped PostgreSQL persistence, and bilingual HTML/API workflows. The collector accepts an explicit Cluster identity and approved scope; deterministic tests suppress objects outside that scope, while missing production Kubernetes settings select an inert adapter.

Verified with frozen offline dependency installation, formatting, lint, strict typechecking, build, focused unit/collector tests, bilingual browser smoke, and disposable PostgreSQL migration/persistence smoke. Live Kubernetes compatibility and production adapter behavior remain unverified by policy; no live Cluster, VM, cloud system, credential, or external account was contacted.
