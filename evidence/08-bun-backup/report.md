# Ticket 08 — encrypted backup on Bun

**Status:** resolved

## Scope

This report covers only the disabled-by-default encrypted backup process. The migration process remains on Node, PostgreSQL 18 and `pg` remain unchanged, and pnpm, TypeScript, and the Node Playwright runner remain the validation toolchain. No object-storage endpoint or credential was contacted.

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

## Residual boundaries

- Live backup upload, object-storage lifecycle behavior, off-VM restore, and production enablement remain unverified and belong to the separately authorized live backup/restore work.
- Registry publication and protected production promotion remain unverified. No credentials, endpoint values, tokens, or plaintext backup bytes were recorded.
