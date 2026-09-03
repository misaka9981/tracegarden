# Ticket 07 — ARM64 migration process on Bun

**Run:** `tracegarden-migrate-07-c7b46b3`
**Tested source commit:** `c7b46b3c79dcd4b25396f82d70b2c0950bc0bf6b` (`feat: run migrations on Bun`)
**Status:** resolved

Sanitized command transcript: [`vm-kind-transcript.txt`](vm-kind-transcript.txt).

## Source and scope

A clean `git archive` was created from the exact tested commit and transferred to the authorized VM. The archive contained 219 tracked paths and extracted to 219 files. No Git credentials, local secrets, build caches, environment values, application data, or unrelated files were transferred. The final amended `HEAD` was compared with the tested commit using `git diff-tree --no-commit-id --name-only -r`; only `.scratch/tracegarden-stack-modernization/issues/07-run-migrations-on-bun.md`, `evidence/07-bun-migrations/report.md`, and `evidence/07-bun-migrations/vm-kind-transcript.txt` differ, proving metadata-only finalization.

This ticket changes only the one-shot migration process. The production migration image uses the exact ARM64 Bun `1.3.14` image:

`docker.io/oven/bun:1.3.14-slim@sha256:6068a9d40e9fc5c4519891edb63dfc5935c393fe2228eb9a5b7f472b444b5ee2`

It runs `bun dist/apps/migrate/src/main.js` as the non-root `bun` user. It contains no separate Node base, Node entrypoint, `/usr/local/bin/node`, or `node` on `PATH`. PostgreSQL 18.3, `pg`, migration SQL, ordering, advisory locks, rollback, readiness deadlines, schema verification, and cleanup contracts remain unchanged.

## Validation results

### Local source checks

On this exact source commit, the bounded local checks passed: frozen install, format check, lint, strict typecheck, build, chart render/validation, delivery validation/policy, and `git diff --check`. The local migration-focused command is covered by the VM run below because the host has no Bun binary.

### Authorized ARM64 VM

The VM reported `aarch64`, Docker server `29.1.3` with `linux/arm64`, and the exact pinned Node, Bun, and PostgreSQL references were available locally. Run-owned tooling was used only under `/tmp/tracegarden-migrate-07-c7b46b3`: Bun `1.3.14`, pnpm `11.9.0`, Docker Buildx `v0.36.1`, and Docker Compose `v5.1.4`. Each SSH, Kubernetes, wait, and log command had explicit short outer bounds; no blind rollout or log wait was used.

The exact tested source was built with the pinned Node image. `PATH=<run-owned Bun> node scripts/migrate-bun-smoke.mjs` passed:

`Bun migration fresh-install, upgrade, concurrent-lock, failed-rollback, and retry checks passed`

This real Bun migration smoke used disposable PostgreSQL and proved fresh installation, idempotent upgrade, concurrent advisory-lock invocation, transactional rollback with no leaked data or migration row, trigger repair, and retry to 15 migrations.

The production migration image was built with `--no-cache --network none --pull=false` for `linux/arm64`. Its image ID was `sha256:719cedc90659513ba7a149d7012dbd694e6989e106ae3962257958e0206ee3a9`, architecture `arm64/linux`, configured user `bun`, and Bun version `1.3.14`. A read-only, capability-dropped, pull-never run proved `/usr/local/bin/node` was absent and `command -v node` failed.

### Authorized kind context

The exact authorized context was `kind-k8s-cluster-v137`. Both named nodes reported Kubernetes `v1.37.0` and `arm64`. The run image was loaded only into those nodes. A run-labelled namespace `tg07-kind-c7` hosted disposable PostgreSQL and two one-shot migration Jobs using `imagePullPolicy: Never`, no service-account token, non-root UID/GID 1000, read-only root, no privilege escalation, and all capabilities dropped.

- `tg07-migrate-a`: `SUCCEEDED=1`, `FAILED=<none>`, log `Tracegarden migrations applied`
- `tg07-migrate-b`: `SUCCEEDED=1`, `FAILED=<none>`, log `Tracegarden migrations applied`
- Database result: `15:15` (`count(*)` and `count(DISTINCT id)`)

The migration-focused VM smoke covers fresh, upgrade, concurrent, failure/rollback, and retry behavior. The kind Jobs provide an additional direct production-image concurrent execution check against the authorized kind PostgreSQL service.

## Cleanup and preservation

The run-labelled namespace, Jobs, Pod, Service, temporary manifest, local run image, imported image on both named kind nodes, generated files, tool directory, and temporary source archive were removed with bounded commands. Post-cleanup checks reported the namespace absent and the run image absent on both named nodes.

The pre/post IDs and running states of the only inspected existing containers were identical:

| Container | Before ID | After ID | Running |
| --- | --- | --- | --- |
| `railgun-caddy` | `26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75` | `26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75` | `true` |
| `k8s-cluster-v137-control-plane` | `d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc` | `d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc` | `true` |
| `k8s-cluster-v137-worker` | `ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e` | `ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e` | `true` |

No unrelated Docker resource, kind node, context, namespace, Secret, ConfigMap, Caddy configuration, or object-storage service was touched. No credentials, tokens, cookies, passwords, private keys, protected rows, or dump contents are present in this evidence.

## Remaining boundaries

Live production Kubernetes, registry publication, GitHub, Google OAuth, Cloudflare, object storage, restore-host, and production-promotion behavior remain unverified under their separate authorization boundaries. The VM's system Node was `v22.23.2`; the migration build used the exact pinned Node image, while the migration process and production image ran under Bun `1.3.14`.
