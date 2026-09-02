# Ticket 22 kind/Kubernetes boundary evidence

Profile: `kind-host-network-apiserver-validation`
Run: `tracegarden-live-20260902-0813-22a7`

The evidence is partitioned between the criteria attested by the bounded run and the CNI-specific NetworkPolicy path that remains unverified. The original application run is not being rerun; the separate bounded policy-state rehearsal is recorded below.

## Attested criteria

### Authorized cluster and safety boundary

All cluster-touching Kubernetes, Helm, and kind commands after the required first read ran over SSH with BatchMode, ConnectTimeout=10, IdentitiesOnly, the authorized key, and normal known_hosts. Local `helm template`/`helm lint` checks were offline render checks and did not contact a cluster. The first Kubernetes read was only:

```text
kubectl config current-context
kind-k8s-cluster-v137
```

The explicitly named context matched the authorized kind cluster. The final bounded verification used only `--context kind-k8s-cluster-v137` and `kind get nodes --name k8s-cluster-v137`:

```text
k8s-cluster-v137-control-plane   v1.37.0   arm64
k8s-cluster-v137-worker          v1.37.0   arm64
k8s-cluster-v137-control-plane
k8s-cluster-v137-worker
```

No other contexts, namespaces, Secrets, ConfigMap values, or unrelated workloads were enumerated. Only the exact built-in `kubernetes` Service/Endpoints and exact named kind containers were inspected to characterize the authorized API boundary. The steering check found no active run-owned Docker load process or archive; bounded collector logs contained only sanitized lifecycle/watch fields.

### Application proof and source fixes

The run namespace was `tracegarden-live-20260902-0813-22a7`, labelled `tracegarden.run=tracegarden-live-20260902-0813-22a7`. Only local ARM64 images were retagged, copied over SSH, loaded into Docker and the two named kind nodes, then removed after cleanup. No public pull or third-party credential was used.

The chart installed with ingress disabled. Run Services exposed only ports 80 (web), 3001 (collector), and 5432 (PostgreSQL); no run Ingress existed and no application listener on 443 was used. Migration, PostgreSQL, and web reached readiness. Collector readiness reached:

```json
{"status":"ready","checks":{"database":"ready","migrations":"ready","collector":"ready","clusterContacted":true},"signals":{"reconnects":0,"relists":0,"normalizationFailures":0,"persistenceFailures":0,"lastResourceVersion":"617750","failedNamespaces":[]}}
```

The production chart originally hard-coded `tracegarden-production`, which did not exist in the disposable run. PostgreSQL also needed its runtime socket directory writable on this image. The owning chart was fixed rather than weakening deployment:

- `priorityClassName` is now a required, validated chart value used by web, collector, migration, and PostgreSQL pods.
- PostgreSQL receives a memory-backed `/run/postgresql` mount.
- `scripts/chart-test.mjs` checks both render constraints.

### List/watch, durable timeline, restart, and relist

A run-labelled Deployment fixture and its run-labelled Pods were created and then scaled from one to two replicas with a fixture annotation change. The collector observed both Deployment and Pod list/watch changes. A bounded application/database API query (no raw rows) reported after the changes:

```json
{"fixtureCounts":{"deployments":10,"pods":10,"uniqueSourceKeys":20,"duplicateSourceKeys":0},"checkpoints":{"Deployment":{"resourceVersion":"617829"},"Pod":{"resourceVersion":"618780"}}}
```

The source keys were durable identity keys, and the duplicate count was zero. The query intentionally returned only IDs, kind/name, resource version, source key, and timestamps; no secret, token, or raw database row was exposed.

The collector was deleted and recreated after fixture observations were durable. It resumed from checkpoints and remained ready. A bounded stale-resource-version test used resource version `1` and received an API watch `ERROR` with status `410`. The collector recovery path was then exercised by preparing stale checkpoints through the database API, restarting only the run collector, and observing:

```text
collector readiness: ready
tracegarden_collector_relists_total 1
tracegarden_collector_normalization_failures_total 0
tracegarden_collector_persistence_failures_total 0
fixture duplicateSourceKeys: 0
```

### Application RBAC and bounded logs

The run observation identity matrix was checked with `kubectl auth can-i` using the explicit context. The subresource form was checked correctly with `--subresource=log`:

```text
observation: get/list/watch deployments = yes
observation: get/list/watch pods = yes
observation: get pods --subresource=log = no
observation: get/list secrets = no
observation: create/patch/delete deployments = no
logs-reader: get pods --subresource=log = yes
logs-reader: get pods = no
logs-reader: get/list secrets = no
logs-reader: patch/delete pods = no
```

The separate log identity fetched a bounded tail through the production log adapter:

```json
{"ok":true,"contacted":true,"bounded":true,"lineCount":5,"byteCount":149}
```

### Cleanup and preservation

Cleanup removed the fixture and helper resources by `tracegarden.run`, uninstalled the exact run Helm release, removed the exact run PriorityClass, run Secrets, PVC, namespace, Docker tags/archive, and the exact run image references from both named kind nodes. No global prune was used.

Post-cleanup checks reported the run namespace, PriorityClass, and Helm release absent; no run image references or archive remained. The exact pre/post preserved Docker identities were unchanged and running:

```text
railgun-caddy                    26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75 running
k8s-cluster-v137-control-plane   d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc running
k8s-cluster-v137-worker          ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e running
```

## CNI-specific unverified path

The exact built-in Service was `10.96.0.1:443`, with endpoint `172.18.0.3:6443`. The run's normal policy was restored to the narrow `10.96.0.1/32` TCP/443 rule. Under this kind CNI, the collector's host-network kube-apiserver path was not portable through the narrow rules exercised:

- exact service CIDR/port and exact control-plane endpoint/port both timed out;
- the final combined run-only policy containing `10.96.0.1/32` and `172.18.0.3/32` on both TCP 443 and 6443 timed out;
- the approved temporary `0.0.0.0/0` TCP/6443 characterization also timed out;
- deleting only the run collector policy made the same authorized observation API check succeed with 12 resources.

The temporary exception was limited to the run collector policy and was applied only after the narrow policy probes failed, for the remaining authorized application/RBAC evidence. The run-only policy was restored to the narrow `10.96.0.1/32` TCP/443 rule before cleanup; cleanup then removed the run namespace and all remaining run-labelled resources. No broad rule was committed or left installed. Production NetworkPolicy defaults remain mandatory; this report does not claim NetworkPolicy portability, a production workaround, or a disabled-policy mode.

## New policy-state rehearsal

Profile: `kind-networkpolicy-state-rehearsal`
Run/namespace: `tracegarden-live-20260902-103712-policy`
Release: `tracegarden-policy-state-20260902-103712`

The rehearsal used only SSH to the authorized VM (`ubuntu@161.33.30.111`), explicitly checked current context `kind-k8s-cluster-v137`, and inspected only the exact Cilium DaemonSet and named Caddy/kind containers. The CNI identity/version was recorded as Cilium image `quay.io/cilium/cilium:v1.20.1@sha256:ae9ea21f7427fe24bc6ea7247eb552157a1b0a431744045d3f641545ca71d11b`. The rendered chart policy subset contained only five run-labelled NetworkPolicies: `tracegarden-policy-state-20260902-103712-web`, `tracegarden-policy-state-20260902-103712-collector`, `tracegarden-policy-state-20260902-103712-postgres`, `tracegarden-policy-state-20260902-103712-migration`, and `tracegarden-policy-state-20260902-103712-backup`.

This was a policy-state rehearsal, not a traffic probe: the pre/post-Service-DNAT evaluation point was not observed and no target tuple is inferred from this run. The prior ticket22 characterization recorded the candidate tuples `10.96.0.1:443` (Service ClusterIP/Service port) and `172.18.0.3:6443` (endpoint IP/target port), but did not establish which CNI evaluation point applies. Issue 29 remains the follow-up for that target-CNI measurement.

The exact secret-free remote output was:

```text
authorized-context=kind-k8s-cluster-v137
cni=Cilium
cni-image=quay.io/cilium/cilium:v1.20.1@sha256:ae9ea21f7427fe24bc6ea7247eb552157a1b0a431744045d3f641545ca71d11b
before-namespace-create 2026-09-02T10:38:46+00:00
NetworkPolicies: none (validation namespace absent)
during-namespace-created 2026-09-02T10:38:46+00:00
during-policy-apply-start 2026-09-02T10:38:46+00:00
during-policies-applied 2026-09-02T10:38:46+00:00
NetworkPolicies: tracegarden-policy-state-20260902-103712-backup,tracegarden-policy-state-20260902-103712-collector,tracegarden-policy-state-20260902-103712-migration,tracegarden-policy-state-20260902-103712-postgres,tracegarden-policy-state-20260902-103712-web
during-collector-delete-start 2026-09-02T10:38:47+00:00
during-collector-absent 2026-09-02T10:38:47+00:00
NetworkPolicies: tracegarden-policy-state-20260902-103712-backup,tracegarden-policy-state-20260902-103712-migration,tracegarden-policy-state-20260902-103712-postgres,tracegarden-policy-state-20260902-103712-web
during-collector-absent-rechecked 2026-09-02T10:38:50+00:00
NetworkPolicies: tracegarden-policy-state-20260902-103712-backup,tracegarden-policy-state-20260902-103712-migration,tracegarden-policy-state-20260902-103712-postgres,tracegarden-policy-state-20260902-103712-web
during-collector-restore-start 2026-09-02T10:38:50+00:00
during-all-policies-restored 2026-09-02T10:38:51+00:00
NetworkPolicies: tracegarden-policy-state-20260902-103712-backup,tracegarden-policy-state-20260902-103712-collector,tracegarden-policy-state-20260902-103712-migration,tracegarden-policy-state-20260902-103712-postgres,tracegarden-policy-state-20260902-103712-web
after-namespace-delete-start 2026-09-02T10:38:51+00:00
after-namespace-delete-complete 2026-09-02T10:38:56+00:00
namespace-absent=yes
preserved-container-identities=unchanged
rehearsal=passed
```

The collector was the only policy deleted; web, PostgreSQL, migration, and backup remained present at both during checks. The collector was restored before deleting only the run namespace. The before/after named-container identities were identical and running: Caddy `26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75`, kind control-plane `d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc`, and kind worker `ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e`. The temporary policy files and script were removed from the VM after the run. No Secret or ConfigMap contents and no unrelated namespace data were read or recorded.

## Review-checkable local validation

The review checkout passed `mise exec node@26.8.0 -- pnpm install --frozen-lockfile --offline`; the lockfile was unchanged and all dependencies were reused from the local store. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test:chart`, `pnpm chart:render`, and `pnpm chart:validate` passed. The chart test and schema validation were offline; chart validation accepted all 21 rendered resources. A direct production render assertion found `tracegarden-collector` with mandatory `Ingress`/`Egress` policy types and TCP/6443 API egress. `git diff --check` passed. The policy-state rehearsal above is the only live Cluster mutation in this update; all listed local checks were offline.

## Secret audit

This report contains no credential, token, cookie, authorization code, private key, full identity value, plaintext dump, protected row content, or Secret/ConfigMap value. Identifiers are run labels, resource names, hashes, bounded counts, and pre/post container identities only.
