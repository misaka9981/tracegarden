# 29: Prove target-CNI kube-apiserver NetworkPolicy egress

**What to build:** A bounded, secret-free live check proves that the production CNI carries the required narrow Kubernetes API egress for Tracegarden's collector and web workloads without weakening production policy.

**Blocked by:** None

**Blocking:** non-blocking follow-up; this does not block ticket 22's application and RBAC resolution.

**Status:** needs-info

- [ ] Before any mutation, the operator records the exact production CNI identity/version, API Service/endpoint path, authorized test namespace, cleanup authority, and expected target tuple.
- [ ] With production NetworkPolicies enabled, the collector and web workloads each prove only the narrow target-CNI-supported API egress required by their configured Kubernetes API endpoint and port.
- [ ] The evidence records the observed pre- or post-Service-DNAT evaluation point and exact target tuple (Service ClusterIP/Service port or endpoint IP/target port), plus CNI-specific routing/policy evidence; API reachability remains separate from application readiness and RBAC results.
- [ ] The check never adds `0.0.0.0/0` or another broad API egress rule, disables or bypasses a production NetworkPolicy, or adds a disable switch.
- [ ] The check does not use a proxy or mutate the CNI, its configuration, or cluster-wide policy machinery as a workaround.
- [ ] All disposable workloads and policy probes are removed by run label, and the production policy defaults and unrelated workloads remain unchanged.

## Safe stop rules

Stop before mutation if the production CNI identity/version, API endpoint, policy ownership, test namespace, cleanup authority, or evaluation target is ambiguous. Stop if the observed evaluation point cannot be measured or proving reachability would require a broad rule, disabled production policy, proxy, CNI mutation, or cluster-wide privilege.

## Needed from the operator

Provide the named production CNI and version, its documented API egress behavior, the authorized disposable namespace and run label, the exact narrow collector/web API egress targets, and cleanup authority. Evidence must state whether evaluation was pre- or post-Service-DNAT and record the observed tuple: Service ClusterIP plus Service port, or endpoint IP plus target port. Do not provide credentials or Secret values in the issue or evidence.
