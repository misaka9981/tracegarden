# Operations

## Retention

Ordinary Kubernetes Observations default to 90 days. An owner can configure the period. Experiments and entries participating in Confirmed Links are retained until explicitly deleted. Cleanup is an idempotent scheduled job and reports deleted counts without logging deleted payloads.

## Backups

The deployment includes a disabled CronJob template for encrypted PostgreSQL backups to Cloudflare R2. It remains disabled until a bucket, endpoint, encryption mechanism, retention schedule, and credentials are explicitly configured.

An acceptable backup setup must prove both directions:

- A scheduled backup produces an encrypted off-VM artifact.
- A documented restore rehearsal can populate a clean PostgreSQL instance and pass integrity checks.

Copying a dump to the same VM is not considered disaster recovery. Backup or OAuth secrets never enter Git, ordinary ConfigMaps, command output, or application telemetry.

## Observability

The application emits OpenTelemetry traces, metrics, and structured logs through optional exporters. It also provides:

- startup, readiness, and conservative liveness endpoints
- Prometheus-compatible operational metrics
- collector lag, reconnect, relist, normalization failure, and persistence failure metrics
- SSE client count and cursor lag
- database pool and migration status

No complete monitoring stack is installed by this project. Missing exporters do not prevent startup. Container log bodies obtained through Recent Log Window are excluded from logs, traces, metrics, exception messages, and analytics.

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
