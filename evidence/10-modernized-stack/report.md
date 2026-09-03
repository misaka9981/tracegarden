# Ticket 10 — reprove the modernized stack

**Status:** resolved

## Tested source and scope

The final acceptance source was the clean tracked archive of `b154d5a8b6364f76a14a0d5b83158c32f07baff5` with tree `8194a9da89c1fed009ffee870190a983ff07666e`. The archive was transferred to the authorized ARM64 VM and extracted into a run-owned directory. The archive contained no Git metadata, credentials, local secrets, build caches, application data, or unrelated files.

The accepted stack is Hono transport with server-rendered Hono JSX views, Bun `1.3.14` for all four production processes, pnpm `11.9.0`, Node-based TypeScript and Playwright validation, `pg`, and PostgreSQL 18. No React, TanStack, SQLite, PGlite, DuckDB, or alternate production database was introduced.

This ticket is an aggregation gate, not a feature rewrite. The application/runtime seams were validated by Tickets 02–08; Ticket 09 integrated the four-process Bun delivery. The final VM acceptance below validates the integrated source and delivery boundary. Before finalization, `git diff --name-only b154d5a8b6364f76a14a0d5b83158c32f07baff5 HEAD` listed exactly `.scratch/tracegarden-stack-modernization/issues/10-reprove-modernized-stack.md`, `evidence/10-modernized-stack/report.md`, and `evidence/10-modernized-stack/vm-transcript.txt`; no runtime-bearing path differed. The same path-equivalence check is rerun after this metadata amend.

## Local and ARM64 VM acceptance

The host is an authorized ARM64 VM (`aarch64`, Docker `linux/arm64`). Run-owned user-space tooling supplied pnpm `11.9.0`, Bun `1.3.14`, Docker Buildx, Docker Compose, kubeconform `v0.6.7`, and Playwright Chromium/headless-shell `1223`; no system installation or credential source was used. The acceptance process ran in a temporary ARM64 helper image derived from the exact pinned `node:26.8-bookworm` reference and reported `node --version` as `v26.8.1` before starting acceptance. The helper only added the browser's Debian runtime libraries; production images and repository files were unchanged.

The final VM run was `tracegarden-ticket10-20260904T084636Z-60396`. Earlier bounded setup attempts stopped before full acceptance (one isolated the disposable database from the orchestrator, and one lacked browser runtime libraries); they did not touch source or kind resources. After those setup corrections, the final command exited `0`:

```text
node --version  # v26.8.1; checked before acceptance
PATH=/tmp/$RUN/tools/bin:$PATH \
DOCKER_CONFIG=/tmp/$RUN/docker-config \
PLAYWRIGHT_BROWSERS_PATH=/tmp/tracegarden-migrate-07-935d519/ms-playwright CI=true \
timeout 1700s pnpm acceptance

Tracegarden local acceptance workflow passed; no external integrations were contacted.
```

All 20 sequential stages passed: format, lint, strict typecheck, production build, Bun compatibility, Bun migration fresh/upgrade/lock/rollback/retry, acceptance preflight, frozen dependency policy, clean-cache offline builds, unit/domain, Bun collector resilience, PostgreSQL integration, bilingual browser smoke, browser core-loop, Bun backup/restore, checked-in schemas, chart, preview/promotion, delivery policy, and production container smoke.

The final outputs include:

- `Playwright browser smoke passed`.
- `Playwright core-loop acceptance passed`: admitted login, deterministic Observation, live delivery/recovery, structured Experiments, rejected/confirmed correlation review, persisted history, and bilingual UI.
- Offline backup encryption, native SigV4 fixed vector, perturbation, timeout cancellation, off-VM gate, and credential-free boundary passed.
- Offline chart render, upgrade, failure-gate, policy, preview/promotion, and delivery checks passed.
- ARM64 Bun `1.3.14` web, collector, and migration non-root/read-only, migration gate, invalid-URL, and schema-failure smoke passed; backup `pg_dump` and `pg_restore` both reported PostgreSQL `18.3`.

A sanitized bounded transcript is retained at [`vm-transcript.txt`](vm-transcript.txt). It records the exact tested source, the actual Node process version, the final command, all 20 stage results, and cleanup/preservation checks.

## Production image and manifest boundary

The four production processes use the same immutable ARM64 Bun image:

`docker.io/oven/bun:1.3.14-slim@sha256:6068a9d40e9fc5c4519891edb63dfc5935c393fe2228eb9a5b7f472b444b5ee2`

The clean-cache builds used `--no-cache --network none --pull=false` for `linux/arm64`. Production smoke used pull-never execution, non-root `bun`, read-only filesystems, dropped capabilities, and bounded temporary filesystems. Each image rejected both `/usr/local/bin/node` and `command -v node`. Chart, preview, promotion, delivery-policy, and checked-in schema validations passed offline. The final run did not enable backup or contact object storage; the backup image binaries were exercised locally and on the VM.

## Authorized kind evidence

Ticket 10 deliberately does not claim a new broad Cluster mutation. The authorized kind proof is the bounded, run-labelled predecessor evidence, partitioned by process and seam:

| Boundary | Evidence | Proven behavior |
| --- | --- | --- |
| Web/Bun | `evidence/05-bun-web/report.md` | Real Bun entrypoint, readiness/health, Hono/SSE behavior, browser flow, shutdown, cleanup, and preserved Caddy/kind identities |
| Collector/Bun | `evidence/06-collector-bun/report.md` | Real Bun entrypoint on kind; readiness/shutdown; Bun production adapter list/watch, cancellation, checkpoint, reconnect/relist, buffering, and failure paths; cleanup |
| Migration/Bun | `evidence/07-bun-migrations/report.md` and `vm-kind-transcript.txt` | Real Bun kind Jobs, concurrent execution, migration result `15:15`, transactional rollback/retry, cleanup, and preserved identities |
| Combined kind behavior | `evidence/22-kind-kubernetes/report.md` | Authorized `kind-k8s-cluster-v137`, ARM64 nodes, web/collector/migration readiness, list/watch, checkpoints, restart, real `410` relist, RBAC, bounded logs, scoped cleanup, and preservation |
| Argo/lifecycle preservation | `evidence/23-kind-argocd/report.md` | Real ApplicationSet/controller lifecycle in the same authorized kind boundary and unchanged Caddy/kind identities |

The predecessor reports identify the exact context `kind-k8s-cluster-v137`, run-owned namespaces/labels, bounded commands, cleanup, and named Caddy/kind container identities. No Ticket 10 VM acceptance command touched kind. The kind evidence does not assert production NetworkPolicy portability: the kind host-network API path remains explicitly covered by the validation-only exception and Ticket 29 follow-up.

## Browser route and behavior partitions

The final VM browser and core-loop stages exercised the existing bilingual and capability partitions, including:

- unauthenticated landing/login and admission denial;
- owner admission, session/capability visibility, redirects, cookies, health, and metrics;
- Chinese and English Workspace/Timeline pages;
- Cluster scope valid save and invalid URL rejection;
- retention read/write and cleanup;
- Experiments create, update, detail route, tags, and lifecycle state;
- Timeline list/filter, unread attention, live delivery, duplicate suppression, SSE failure/recovery, reconnect, and persisted history;
- Correlation Suggestions, confirm/reject, conflict `409`, rejected state, and capability-denied partitions;
- bounded recent logs and denied log access;
- membership invitation, revoke, role update, owner/operator/viewer capability partitions, and denied member management;
- unknown/error/unauthorized route outcomes without protected values in rendered HTML.

These are exercised by `scripts/browser-smoke.mjs` and `scripts/core-loop-browser.mjs`, both included in the final VM acceptance. The browser evidence contains no database URL, token, password, authorization code, private key, or full protected identity.

## Cleanup and preservation

After acceptance, the final VM run directory, downloaded tools, browser artifacts, source archive, generated container context, helper image, run-owned images, containers, networks, and volumes were removed. No global prune was used. The final bounded post-cleanup check reported `run-dir-after=absent`.

The named existing containers were unchanged and remained running:

| Container | Before ID | After ID | Running |
| --- | --- | --- | --- |
| `railgun-caddy` | `26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75` | `26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75` | `true` |
| `k8s-cluster-v137-control-plane` | `d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc` | `d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc` | `true` |
| `k8s-cluster-v137-worker` | `ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e` | `ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e` | `true` |

## Unverified boundaries

The following remain intentionally unverified and unauthorized: Google OAuth callbacks, Cloudflare Access, GitHub/GHCR publication, remote registry attestations, object-storage upload and lifecycle, off-VM restore, target production CNI NetworkPolicy behavior, Argo CD production reconciliation, and protected production promotion. The final acceptance did not contact any of these systems or inspect credential stores.

The final evidence is limited to local/authorized VM execution and the separately recorded authorized kind predecessor runs. No claim of production readiness or external integration success is made.
