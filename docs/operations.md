# Operations

## Retention

Ordinary Kubernetes Observations default to 90 days. An owner can configure the period. Experiments and entries participating in Confirmed Links are retained until explicitly deleted. Cleanup is an idempotent scheduled job and reports deleted counts without logging deleted payloads.

## Backups

The deployment includes a suspended-by-default CronJob template for encrypted PostgreSQL backups to S3-compatible off-VM object storage (Cloudflare R2 is one possible later configuration). It remains suspended until an HTTPS endpoint, bucket, encryption mechanism and key Secret, object-storage credential Secret, schedule, positive retention period, and off-VM destination are explicitly configured. See [Backup and restore rehearsal](backup-restore.md).

The backup process encrypts the `pg_dump` artifact before invoking the uploader. Backup and restore secrets never enter Git, ordinary ConfigMaps, command output, or application telemetry. The offline process test uses no cloud endpoint or credential.

An acceptable backup setup must prove both directions:

- A scheduled backup produces an encrypted off-VM artifact.
- A documented restore rehearsal can populate a newly created clean PostgreSQL instance and pass integrity and application-readable checks.

Copying a dump to the same VM is not considered disaster recovery. Live upload and restore rehearsal remain **unverified** until authorized storage, restore infrastructure, and credentials are supplied.

## Recent Log Window

Recent Log Window requests require the owner-only `logs:read` Capability and an approved Cluster namespace. Production log access is configured with `KUBERNETES_LOG_API_SERVER` and the web workload's automounted logs-reader ServiceAccount, which are separate from the collector's `KUBERNETES_API_SERVER` and automounted observation ServiceAccount. Responses are ephemeral and capped at 200 lines or 1 MiB. Only Cluster, namespace, Pod, container, tail, and result-size metadata is audited; bodies never enter PostgreSQL, caches, indexes, telemetry, analytics, or exception messages.

## Observability

Web and collector expose separate probes:

- `/health/startup` is `200` only after migrations, the initial database check, and the HTTP listener complete. A failed migration or initial database check fails startup rather than serving partial data.
- `/health/readiness` and `/api/status` report dependency readiness (database, migrations, and web Timeline notification transport). They return `503` while a dependency is unavailable.
- `/health/live` reports the process liveness only. It remains `200` during transient PostgreSQL, Kubernetes, or exporter failures, avoiding an unsafe restart loop. It reports `stopping` while shutdown is in progress.
- `/metrics` is an unauthenticated Prometheus text endpoint containing operational values only.

The application emits OpenTelemetry-compatible spans, structured JSON logs, and Prometheus-compatible metric samples through optional best-effort exporters. Every signal carries server-generated request, trace, and span correlation metadata; incoming `x-request-id` values are not trusted or forwarded. Exporter absence, connection failure, thrown errors, or rejected promises are ignored and never block web requests, ingestion, SSE, or Recent Log Window responses.

The signals mean: collector lag is the age of the newest observed Kubernetes event; reconnects count bounded watch reconnects; relists count recovery from an expired resource version; normalization and persistence failures count rejected or uncommitted observations; SSE clients is the active stream count; cursor lag is the number and age of committed Timeline entries not yet delivered to a stream; database pool gauges show total, idle, and waiting connections; migration status is a gauge with `-1` for failed, `0` for pending, and `1` for ready; and Recent Log Window access count records successful metadata-only requests. Metrics include `tracegarden_collector_lag_seconds`, collector reconnect/relist/normalization/persistence counters, failed namespaces, `tracegarden_sse_clients`, Timeline cursor lag in entries and seconds, `tracegarden_database_pool_total`/`idle`/`waiting`, migration and database readiness, and Recent Log Window access count. Values are counts, states, sizes, or approved resource metadata; protected content is not an attribute.

No complete monitoring stack is installed by this project. Operators choose and configure external OpenTelemetry and Prometheus collectors separately. Container log bodies obtained through Recent Log Window are excluded from logs, traces, metrics, exception messages, and analytics, including failure paths.

## Production containers

The web, collector, migration, and backup Dockerfiles use the exact ARM64-pinned Bun 1.3.14 base after their process-specific compatibility proofs. Runtime stages contain only compiled application JavaScript, migration SQL, backup tooling, and production dependencies; source files, development dependencies, and configuration are omitted. Compose runs web, collector, migration, and the suspended backup CronJob as the non-root `bun` user, all with a read-only root filesystem, `no-new-privileges`, all Linux capabilities dropped, and an explicitly sized `/tmp` tmpfs. The prior Node web, collector, migration, and backup images remain independent rollback baselines; runtime changes are adopted only after equivalent behavior evidence passes.

The `migrate` service is a one-shot, credential-free (apart from its database connection) gate. Web and collector depend on its successful completion and verify the committed migration state at startup without running migrations themselves. The collector receives no Google or Kubernetes credentials; with no explicit Kubernetes endpoint it reports `clusterContacted: false` and remains not ready.

## Kubernetes API egress

Production NetworkPolicy defaults are mandatory. NetworkPolicy evaluation may occur before or after Service DNAT: a pre-DNAT evaluator sees the Service ClusterIP and Service port, while a post-DNAT evaluator sees the selected endpoint IP and target port. Validate the actual tuple with the named target CNI and record its identity/version, observed evaluation point, and target; do not assume that a ClusterIP/Service-port rule also covers endpoint IP/target-port evaluation. If the evaluation point is ambiguous or the narrow check fails, keep the policy closed and stop; do not disable policies, add `0.0.0.0/0`, use a proxy, or mutate the CNI as a workaround. The profile `kind-host-network-apiserver-validation` proves application and RBAC behavior on kind but does not attest NetworkPolicy portability.

## Failure handling

- Kubernetes watch disconnects use finite, bounded backoff and resume from the last persisted cursor.
- `410 Gone` discards the invalid watch cache, performs a fresh list, persists the new checkpoint, and resumes.
- An Observation becomes publishable only after its database transaction commits.
- Duplicate watch delivery is harmless because source identity is unique.
- A required migration failure blocks rollout.
- Best-effort telemetry failure does not block ingestion or web requests.
- Preview capacity exhaustion fails that preview and does not consume production reservations.

## Known environment facts

Verified locally on 2026-09-01:

- macOS host architecture: arm64
- Node.js installed default: 24.14.0
- pnpm: 11.9.0
- Docker CLI: 29.7.2
- kubectl client: 1.37.0
- GitHub CLI: 2.98.0
- Helm CLI: unavailable
- kubeconfig contains company AKS contexts only; current context is `aks-botchan-prod`

The company contexts are outside project scope and must not be contacted. The following remain unverified:

- personal cluster distribution, server version, CPU architecture, and API compatibility
- ingress controller, StorageClass, cert-manager, and Argo CD installation state
- available persistent capacity and production PostgreSQL topology
- Cloudflare domain, Tunnel, Access, R2, and TLS configuration
- Google OAuth client configuration
- `MISAKA3389` GitHub authentication in the local client

Implementation must keep these as configuration or placeholders until primary evidence is available.
