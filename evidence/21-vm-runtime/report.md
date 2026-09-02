# Ticket 21 ARM64 VM runtime evidence

Run: `tracegarden-validation-21-20260902T074817Z-30845`

## Source and boundary

- The exact tested implementation commit was `3240952e49dca28474584d8e8158223705bcb791`, tree `0fc3d8ccddc86e2bfd9612ca73d822feaba54e8d`. A clean `git archive` contained 186 tracked paths and SHA-256 `4884d13332f075f12133106a8902ce23aa063fba7a89d6baa130d2a3295f8126`.
- Remote pre- and post-acceptance `git hash-object` checks matched the local object manifest for all 186 paths. The source-bearing tree was therefore the archive of the tested commit, not an unstaged overlay. Acceptance-generated files were removed with the run directory.
- No Git credentials, key material, environment values, application logs/data, or Kubernetes context were copied. Dependencies, browser data, and runtime tooling stayed in the unique run directory.

## VM baseline and safety

- Authorized VM: Ubuntu 24.04, Linux `6.17.0-1020-oracle`, `aarch64`; Docker `29.1.3` server `linux/arm64`; Helm `v4.1.0+g4553a0a`; system Node `v22.23.2` was not changed. The pinned helper reported Node `v26.8.1` and pnpm `11.9.0`.
- Existing service/container identities were preserved: `railgun-caddy` `26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75`, kind control-plane `d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc`, and kind worker `ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e`. Existing exited containers `crazy_bohr` and `stupefied_ritchie` were left untouched.
- Only run-created resources were removed. After cleanup, no run-named containers, images, networks, volumes, or `/tmp/tracegarden-validation-21-20260902T074817Z-30845` remained. Existing listeners, including ports 22 and 443, were unchanged.

## Readiness implementation and deterministic tests

- `probePostgresReadiness(pool, timeoutMs)` now treats the supplied timeout as the complete acquisition-plus-SQL deadline. It accounts for acquisition elapsed time, limits acquisition to the production pool's native 900 ms `connectionTimeoutMillis` bound, passes only the remaining time as PostgreSQL `query_timeout` and transaction-local `statement_timeout`, and races a cancellable probe deadline so stalled clients are released with a generic timeout error.
- A late-acquired client is released with an error so `pg` destroys it instead of returning it to the pool. A per-pool pending-acquisition gate prevents readiness retries from creating additional pending waiters while a timed-out native acquisition is still settling.
- Deterministic tests cover delayed elapsed acquisition, a hanging acquisition, late-client cleanup before pool close, retry de-duplication, hanging SQL, remaining query timeout, generic timeout errors, and exact total elapsed virtual time. Fake clock/sleeper hooks avoid wall-clock assertions.

## Pinned material and native validation

- PostgreSQL: `postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7`, ARM64 image ID `sha256:ce5a49d4f47955bc3cc0120cb109a39b13a10791e35f5ac8400dc0fd7842ff5e`.
- Node base: `node:26.8-bookworm@sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89`, ARM64 image ID `sha256:2563b93b12a989395d4c4a6392dbd286abb5cf527efc8967784490d17f83e7ad`.
- Native ARM64 kubeconform v0.6.7 was used with no shim or schema-location override. Compose v5.1.4 and Buildx v0.36.1 were native ARM64 CLI plugins. Because this VM had no pre-existing Corepack/pnpm, the pinned pnpm 11.9.0 package-manager tarball was downloaded before execution. The lockfile-resolved dependencies were then materialized in the run-local store with frozen pnpm install.
- The run-local Playwright Chromium cache and a disposable helper image derived from the exact pinned Node base supplied the ARM64 browser and its Debian runtime libraries. These public downloads were named in `download-plan.txt` before execution; no application dependency or package manifest was changed.

## VM acceptance

- Local `pnpm acceptance` passed before the amend. The exact remote acceptance command was bounded by `timeout 1800 docker run --rm --pull=never --platform linux/arm64 --network host --user 0 ... node /tooling/package/dist/pnpm.mjs acceptance`; it reported `acceptance_exit=0`.
- The full ARM64 acceptance passed format, lint, strict typecheck, production build, pinned-image/frozen-dependency policies, clean-cache ARM64 builds, unit/domain/collector suites, real PostgreSQL integration, bilingual browser smoke, focused core-loop browser acceptance, encrypted backup/restore checks, strict offline chart/preview validation, delivery policy, and non-root/read-only production image smoke. It ended: `Tracegarden local acceptance workflow passed; no external integrations were contacted.`
- The run-built ARM64 application image IDs were: web `sha256:605ac8b2d0606db15fdd6d2b259ceaf3a755ce8935c05bcdd7d45a99e4d075c9`, collector `sha256:a47d199b8815a4caccfeaa3a6a0ad01c6fc4ee3a5bd6d8a7ca979542711c9f7b`, migrate `sha256:e99fcaac5deae313fac6b9a838917368b566c37e0451110eec1210f10a703072`, plus the invalid-URL and schema-failure variants. All reported ARM64.

## Cleanup and final commit boundary

- The nine run-created `tracegarden-smoke-2848-*` image tags and disposable helper image `tracegarden-validation-21-20260902t074817z-30845-node-helper:acceptance` were removed by exact name. No global prune, unrelated service mutation, or Kubernetes operation was used.
- Root-owned generated files were removed through a disposable pinned-Node container boundary. The source archive, dependency store, browser cache, native tools, Docker config, helper context, acceptance log, and run directory were then removed. Pinned base images remained available; Caddy, kind, existing listeners, and unrelated exited containers remained unchanged.
- After the successful VM run, metadata was amended only in this evidence report and `.scratch/tracegarden-mvp/issues/21-prove-arm64-vm-runtime.md`. The runtime-bearing tree is explicitly tied to tested commit `3240952e49dca28474584d8e8158223705bcb791`; the final metadata diff is restricted to those two files. No untested runtime-bearing hash is claimed.
- This validates the local acceptance workflow and production container lifecycle only. No external integrations, Kubernetes API operations, cloud metadata, credential stores, Caddy configuration, or unrelated services were exercised. Status remains **claimed** pending fresh review.
