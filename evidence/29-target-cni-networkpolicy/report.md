# Ticket 29 target-CNI NetworkPolicy evidence

Status: **characterized / production target deferred**

This report records a bounded characterization of a **separate disposable Cilium kind cluster**. It does not claim that Cilium is the production CNI or a supported production target for `kind-k8s-cluster-v137`; production-target proof is intentionally deferred. No existing kind cluster, CNI, Caddy route, workload, policy, or production resource was changed.

## Run and immutable versions

- Run label: `tracegarden-cilium-29-20260904-234427`
- Disposable namespace: `tg29-234427`
- Disposable kind cluster: `tg-cilium-29-234427`
- Disposable context: `kind-tg-cilium-29-234427`
- Authorized VM: ARM64 `ubuntu@161.33.30.111`
- kind: `v0.33.0`
- Kubernetes node image: `kindest/node:v1.31.9@sha256:b94a3a6c06198d17f59cca8c6f486236fa05e2fb359cbd75dabbfc348a10b211`
- Node architecture/version: three `arm64` nodes, Kubernetes `v1.31.9`
- Pod CIDR: `10.10.0.0/16`
- Service CIDR: `10.11.0.0/16`
- Cilium Helm chart/app: `1.20.1`
- Cilium agent: `quay.io/cilium/cilium:v1.20.1@sha256:ae9ea21f7427fe24bc6ea7247eb552157a1b0a431744045d3f641545ca71d11b`
- Cilium operator: `quay.io/cilium/operator-generic:v1.20.1@sha256:6c3885fc7b629099fdbe2a5c87869c86feb825fa18fae299eac0f61918d16ecf`
- Cilium Envoy: `quay.io/cilium/cilium-envoy:v1.37.5-1786810558-766ccfb37260a43e9d228837aa84ce3faf9f64e7@sha256:75b8094c7127736a2ffd2dce3945e0931cb6df21b0372ff661940eca26730b91`
- Cilium status: agent `3/3`, operator `1/1`, Envoy `3/3`; Hubble Relay and ClusterMesh disabled.

The cluster was created with `disableDefaultCNI: true`; Cilium was installed only in this new cluster from the pinned local chart with `ipam.mode=kubernetes`, `kubeProxyReplacement=false`, and pull-never-equivalent locally preloaded agent/operator images. The existing `kind-k8s-cluster-v137` context remained separate.

## API target tuple

The built-in Kubernetes API Service and EndpointSlice were read without reading Secrets or ConfigMaps:

```text
Service ClusterIP: 10.11.0.1
Service port/targetPort: 443/6443
EndpointSlice endpoint IP/target port: 172.18.0.5/6443
```

The selected Cilium monitor flow showed the forward path at the endpoint tuple and the reverse Service translation:

```text
Cilium identity 7 = reserved:kube-apiserver
trace to-stack: source probe identity -> kube-apiserver, 10.10.x.x:<ephemeral> -> 172.18.0.5:6443
trace to-endpoint: kube-apiserver -> probe identity, 172.18.0.5: 10.11.0.1:443 -> 10.10.x.x:<ephemeral>
```

This is evidence of a post-Service-DNAT endpoint evaluation target for the forward API flow: the policy-visible destination is the host-network endpoint `172.18.0.5:6443`, while the reply is translated back to `10.11.0.1:443`. The monitor output was bounded and retained only as target/identity/flow metadata; no payload or credential was recorded.

## Isolated web/collector probes

Two run-owned pods used the immutable ARM64 `curlimages/curl@sha256:935d9100e9ba842cdb060de42472c7ca90cfe9a7c96e4dacb55e79e560b3ff40` image. They were labelled `tracegarden.run` plus `tracegarden.component=web|collector`, had separate ServiceAccounts, and had readiness probes that only established probe-process readiness. This is deliberately reported as **probe readiness**, not Tracegarden application readiness.

The collector ServiceAccount received only a run-owned ClusterRole allowing `get/list/watch pods`; the web ServiceAccount received no such binding. Each probe called the Kubernetes API with its mounted ServiceAccount token but reported only HTTP status, never the token or response body.

Baseline with no run NetworkPolicy:

```text
probe readiness: web=true, collector=true
web -> Service API: 403 (API reachable; RBAC denied)
collector -> Service API: 200 (API reachable; RBAC allowed)
web -> endpoint API: 403
collector -> endpoint API: 200
```

Independent host-side RBAC checks matched the in-pod results:

```text
web get pods: no
collector get pods: yes
web list secrets: no
collector list secrets: no
```

## Standard NetworkPolicy characterization

The run applied only standard `networking.k8s.io/v1 NetworkPolicy` objects, separately selecting the web and collector probes. Each policy included the ordinary narrow DNS allowance and one exact `ipBlock` plus TCP port. No broad CIDR, proxy, policy disablement, CNI mutation, or production chart change was used.

Each case was applied, allowed to converge for five seconds, probed separately from web and collector through both the Service URL and endpoint URL, then deleted before the next case. `000` means the bounded curl connection timed out; it is distinct from an API `401/403/200` response.

| Run-only standard rule | Web Service | Collector Service | Web endpoint | Collector endpoint |
| --- | ---: | ---: | ---: | ---: |
| `10.11.0.1/32`, TCP `443` | `000` | `000` | `000` | `000` |
| `10.11.0.1/32`, TCP `6443` (production chart port shape) | `000` | `000` | `000` | `000` |
| `172.18.0.5/32`, TCP `6443` (endpoint tuple) | `000` | `000` | `000` | `000` |

The same API requests without policy returned `403/200`, so these timeouts are policy reachability results rather than readiness or RBAC results. The Cilium monitor trace identified the endpoint as the `kube-apiserver` entity, but standard `ipBlock` rules did not authorize this host-network endpoint path. This means the unchanged production chart's standard `controlPlaneCIDRs`/`controlPlanePort` expression cannot be claimed compatible with this Cilium kind path.

## Cilium-native run-only characterization

To characterize the Cilium behavior without changing production policy, the run temporarily applied a separate `CiliumNetworkPolicy` to each probe with:

- `toEntities: [kube-apiserver]`
- TCP port `6443`
- the same narrow DNS allowance

Results:

```text
Cilium entity policy + DNS: web -> Service API 403, collector -> Service API 200
Cilium entity policy + DNS: web -> endpoint API 403, collector -> endpoint API 200
```

The entity rule restored only the API path needed for the run probes and preserved their separate RBAC outcomes. It was removed before cleanup. This is a Cilium-native characterization only; it is **not** a production workaround and was not added to the chart.

## Safety and cleanup

Before mutation, the existing resources were recorded with their exact names, IDs, status, and running state. The bounded post-cleanup inspection produced the same values:

| Existing resource | Pre-run ID | Post-run ID | Post-run state |
| --- | --- | --- | --- |
| `railgun-caddy` | `26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75` | `26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75` | `running=true` |
| `k8s-cluster-v137-control-plane` | `d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc` | `d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc` | `running=true` |
| `k8s-cluster-v137-worker` | `ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e` | `ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e` | `running=true` |

The context was restored to `kind-k8s-cluster-v137`; the disposable cluster was absent, its host images were removed, and its run directory was removed.

The run namespace, ServiceAccounts, probes, standard NetworkPolicies, CiliumNetworkPolicies, ClusterRole, ClusterRoleBinding, and entire disposable kind cluster were deleted. The original current context was restored to `kind-k8s-cluster-v137`. No existing Caddy/kind IDs changed. No Secrets, ConfigMaps, token values, API response bodies, private keys, cookies, or full identity values were retained.

## Result and remaining information

This run satisfies the disposable Cilium characterization and demonstrates a compatibility gap: Cilium's narrow `kube-apiserver` entity rule reaches the API, while unchanged standard NetworkPolicy `ipBlock` rules do not. Cilium `1.20.1` is not a supported production target, and production-target proof is intentionally deferred. Ticket 29 is administratively closed as `wontfix` for the currently unspecified target. Reopen this ticket or create a successor when the operator names the production CNI and exact version, supplies the real API Service/EndpointSlice tuple and observed pre- or post-Service-DNAT evaluation behavior, authorizes the disposable namespace and run label, and confirms cleanup authority; no production exception should be added merely to make this disposable Cilium result pass.
