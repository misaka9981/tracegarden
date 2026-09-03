# Ticket 08 — encrypted backup on Bun

**Status:** resolved

## Scope

This report covers only the disabled-by-default encrypted backup process. In the current accepted direction, all four production processes use Bun 1.3.14; PostgreSQL 18 and `pg` remain unchanged, and pnpm, TypeScript, and the Node Playwright runner remain the validation toolchain. No object-storage endpoint or credential was contacted.

## Implemented boundary

- `deploy/docker/backup.Dockerfile` uses the pinned ARM64 Bun `1.3.14` image and retains the pinned PostgreSQL 18.3 image as the source for `pg_dump` and `pg_restore` binaries and their required libraries.
- The backup image runs `bun /app/backup.mjs` as the non-root `bun` user. It contains no separate Node runtime. The production chart invokes the Bun entrypoint but remains suspended unless the explicit backup enablement and Secret-referenced configuration are supplied.
- Existing URL and credential validation, encrypted-before-upload behavior, native SigV4 signing, timeout/error redaction, temporary-file cleanup, and PostgreSQL custom-format restore checks remain unchanged. No backup enablement, restore-format change, or object-storage call was made.

## Deterministic evidence

The following checks passed locally with `CI=true`: frozen dependency setup, format check, lint, typecheck, build, acceptance preflight, delivery policy, chart render/upgrade/failure-gate validation, `scripts/backup-test.mjs`, and the Bun backup module import. Backup tests covered AES-256-GCM round-trip and wrong-key rejection, encrypted-only uploader input, URL/credential/configuration rejection, fixed native SigV4 vectors and path perturbation, bounded hanging `pg_dump` termination/reaping, bounded hanging upload cancellation, redacted timeout errors, and direct absence checks for each run-created `tracegarden-backup-*` directory. Clean restore target checks, all required migrations/tables/foreign keys, and application-readable restored data remain covered. The local host is Node `24.14.0`; the repository's required Node range is `26.8.x`, so pnpm emitted the expected engine warning.

## ARM64 VM evidence

On the authorized ARM64 VM (`ubuntu@161.33.30.111`), run directory `tracegarden-ticket08-20260903T051247Z-91769`, the following passed with bounded commands:

- `aarch64` Docker host; exact preloaded Bun `1.3.14` image; direct Bun backup test; and frozen pnpm install/build.
- Clean-cache builds for web, collector, migration, and backup using `--no-cache --network none --pull=false --platform linux/arm64`. The backup result was exercised with `--pull=never`, read-only root, non-root `bun`, dropped capabilities, Bun `1.3.14`, no `/usr/local/bin/node`, and `pg_dump`/`pg_restore` both reporting PostgreSQL `18.3`.
- Full `CI=true pnpm acceptance` passed sequentially, including backup/restore validation, chart and delivery checks, browser/core-loop, PostgreSQL, and container smoke. The acceptance run contacted no object storage and made no Kubernetes or kind/Caddy mutation.

The VM required only run-owned user-space Docker CLI plugins for the bounded build/Compose checks: Docker Buildx `v0.29.1` from the official release URL and Docker Compose `v2.40.3` from the official release URL. They were removed with the run directory after validation.

## Timeout follow-up

After the initial ARM64 run, the updated timeout implementation and tests were rerun in a separate run directory `tracegarden-ticket08-timeout-20260903T150249-39496`. With the exact preloaded ARM64 images, the updated `scripts/backup-test.mjs` passed; `scripts/container-clean-cache.mjs` rebuilt all four images with no cache/network/pull and exercised the backup image's PostgreSQL binaries; and `scripts/container-smoke.mjs` passed with pull-never Compose startup. The run used Node `22.23.2` for its host script runner because the VM host does not provide Node `26.8.x`; the production image smoke remained on the pinned runtimes. No object-storage, Kubernetes, kind, or Caddy operation occurred. The follow-up did not repeat the entire acceptance workflow; the full acceptance result above is the pre-follow-up baseline.

## Final integration-gate rerun

The runtime-bearing integration gate was committed before validation as `02f4e88dd59ebc000f643d873ba8beb87973f115` (`Harden Bun runtime integration gates`), with tree `83fa87f78aa781bfa4fbb58c32626776f43d722e`. A clean archive of that exact commit was transferred to the authorized VM and marked `TESTED_COMMIT`; no working-tree overlay was used.

Ticket 08 history is traceable from the recorded Git/session history: initial Ticket 08 implementation commit `d924b61e51dc9a6f8726efb424c35ef6122fb6c2` (`Run backup tooling on Bun`), timeout/cancellation follow-up `740622d9c0fb3f37acaf477fa44f557ba9b44ff8` (same subject, adding the bounded `pg_dump`/upload tests), and the integrated main commit `ca86f99b1f99c3e228799c51673eec4d6627db2b` (cherry-picked onto the combined Bun web/collector state). The historical report text that described migration as Node belonged to the pre-migration snapshot; it is not the current runtime claim.

On run `tracegarden-ticket09-20260903T1715Z`, the authorized ARM64 VM (`aarch64`, Docker `linux/arm64`) ran `CI=true pnpm acceptance` against the exact tested archive and exited `0`. The final run passed format, lint, strict typecheck, build, Bun compatibility, Bun migration smoke, acceptance preflight, clean-cache offline builds, unit/domain, Bun collector resilience, PostgreSQL, browser/core-loop, Bun backup, schema/chart, preview/promotion, delivery policy, and ARM64 production container smoke. The final output was `Tracegarden local acceptance workflow passed; no external integrations were contacted.`

The VM required only run-owned user-space tools: pnpm `11.9.0` from the pre-existing VM installation, Bun `1.3.14` materialized from the pinned image, Docker Buildx `v0.29.1`, Docker Compose `v2.40.3`, and kubeconform `v0.6.7`. Exact public image references were pulled only into the VM image cache. All run-named containers, images, networks, temporary plugins, source archive, and run directory were absent after cleanup. No object storage, Kubernetes/kind, Caddy, credentials, or unrelated Docker resources were contacted or mutated; the existing named Caddy/kind containers remained running with IDs recorded in the run check.

After successful validation, only this report and `.scratch/tracegarden-stack-modernization/issues/08-run-backup-on-bun.md` were amended as metadata. The verified tree comparison `git diff --name-status 02f4e88dd59ebc000f643d873ba8beb87973f115..HEAD` contains exactly those two metadata paths; the final metadata commit SHA is returned in the acceptance handoff because embedding a commit's own SHA in its contents would be self-referential.

## Residual boundaries

- Live backup upload, object-storage lifecycle behavior, off-VM restore, and production enablement remain unverified and belong to the separately authorized live backup/restore work.
- Registry publication and protected production promotion remain unverified. No credentials, endpoint values, tokens, or plaintext backup bytes were recorded.
