# Ticket 06 — ARM64 collector on Bun

**Status:** resolved

## Scope

This evidence covers only the collector production runtime; Ticket 05 separately covers the web. Migration, backup, PostgreSQL, `pg`, pnpm, TypeScript, Node Playwright, Cluster permissions, and database schema/semantics were not changed by this ticket. The tested collector worktree was based on `c8ae474f160e9799c9375923edd7300f8b649176` with the Ticket 06 changes; the ticket and this report were added after runtime validation.

## Implemented boundary

- The collector production image uses the exact ARM64 Bun `1.3.14` image:
  `docker.io/oven/bun:1.3.14-slim@sha256:6068a9d40e9fc5c4519891edb63dfc5935c393fe2228eb9a5b7f472b444b5ee2`.
- The collector package, Compose service, chart init check, release workflow, preflight, chart, container, and delivery checks invoke Bun. Ticket 05 separately moved web to Bun; migration and backup were outside this ticket's tested scope and were not changed by its validation.
- The collector image runs as `bun`, with no separate Node base, Node entrypoint, or `/usr/local/bin/node`; Bun's intrinsic `/usr/local/bun-node-fallback-bin/node` compatibility path is part of the Bun image and is not a separate runtime.
- The existing compiled application, production dependency, read-only root, dropped-capability, non-root, ARM64, and bounded `/tmp` boundaries remain in force.

## Deterministic and VM evidence

Local deterministic checks passed sequentially: format, lint, typecheck, build, acceptance preflight, collector resilience, chart, delivery policy/validation, and syntax checks. Collector resilience covered independent namespace/kind checkpoints, list/watch ordering, bounded buffering, cancellation, reconnect/backoff, `410 Gone` relist, persisted-scope reconciliation, large resource versions, duplicate suppression, failure paths, and telemetry.

On the authorized ARM64 VM (`ubuntu@161.33.30.111`), using Node `26.8.1`, frozen pnpm dependencies, and bounded commands:

- `pnpm test:bun` passed with Bun `1.3.14`, real PostgreSQL/`pg` timeout and recovery, LISTEN/NOTIFY, Kubernetes client request construction, deterministic collector behavior, backup/migration imports, and web/collector signal seams. The updated script runs `bun scripts/collector-resilience.mjs` before the broader Bun compatibility harness.
- The same updated `scripts/collector-resilience.mjs` passed directly inside the exact ARM64 Bun image (`docker.io/oven/bun:1.3.14-slim@sha256:6068a9d40e9fc5c4519891edb63dfc5935c393fe2228eb9a5b7f472b444b5ee2`) with `--pull=never` and `--network none`, covering production Kubernetes adapter list/watch streaming, cancellation, reconnect/relist, checkpoint, scope, buffering, and failure paths under Bun.
- Clean ARM64 container build and smoke passed for the immutable collector image and the existing web/migration/backup images. The collector was verified as non-root, read-only, capability-dropped, ARM64, and Bun `1.3.14`; the image build used no network, no pull, and no cache.
- Full `CI=true pnpm acceptance` passed all sequential stages, including collector resilience, PostgreSQL, browser/core-loop, backup, chart/delivery, and container checks. No external integrations were contacted.

## Authorized kind smoke

The exact context `kind-k8s-cluster-v137` was used with run-owned namespace `tracegarden-ticket06-kind-20260903` and Pod `collector-bun`. A fresh ARM64 collector image built with the same no-cache/network/pull restrictions was loaded only into the two named kind nodes. The Pod used `imagePullPolicy: Never`, no ServiceAccount token, no credentials, `runAsNonRoot`, UID/GID 1000, read-only root, no privilege escalation, all capabilities dropped, and a memory-backed `/tmp`.

The Pod reached `Running`; `id -un` returned `bun`, `bun --version` returned `1.3.14`, and an in-Pod request to `/health/live` returned `200`. Collector startup was present in bounded logs. Deleting the Pod with a 30-second wait completed signal shutdown. The deterministic and VM acceptance suites provide the collector's full list/watch, checkpoint, relist, PostgreSQL, and telemetry behavior; this kind smoke specifically proves the production Bun image starts and shuts down on the authorized kind runtime.

The pre/post identities and running state of the only inspected existing containers were unchanged:

| Container | Before ID | After ID | Running |
| --- | --- | --- | --- |
| `railgun-caddy` | `26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75` | `26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75` | `true` |
| `k8s-cluster-v137-control-plane` | `d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc` | `d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc` | `true` |
| `k8s-cluster-v137-worker` | `ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e` | `ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e` | `true` |

The run namespace, Pod, host image tag, and loaded node images were removed after the smoke. Post-cleanup checks reported namespace and image absent. No unrelated Docker resource, Caddy container, or kind node was deleted or recreated.

## Residual boundaries

- The local host remained Node `24.14.0`; the repository requires `26.8.x`. Local Docker capacity also prevented repeating image-heavy acceptance on the host; the complete acceptance run passed on the authorized ARM64 VM under Node `26.8.1`.
- This does not attest production Kubernetes, registry publication, Cloudflare, Google OAuth, object storage, or production promotion. Those remain the previously documented external boundaries.
