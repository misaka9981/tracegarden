# 21: Prove the ARM64 VM runtime baseline

**What to build:** A maintainer can reproduce the accepted Tracegarden workflow and production container lifecycle on the authorized ARM64 VM without using external integrations or Kubernetes.

**Blocked by:** None.

**Status: claimed**

- [x] The exact reviewed `main` commit is transferred to `ubuntu@161.33.30.111` without copying Git credentials, local secrets, build caches, or unrelated files.
- [x] The VM records Ubuntu, ARM64, CPU, memory, disk, Docker, Node, Corepack, Helm, and Git metadata without exposing environment values or credential stores.
- [x] The project-pinned package manager and Node 26.8.x run in a user-owned or containerized boundary; system Node and unrelated services are not replaced.
- [x] `pnpm acceptance` passes on the VM using only locally materialized pinned images and dependencies; any required public downloads are named and recorded before execution.
- [x] Production web, collector, migration, and backup images build for ARM64 and pass non-root, read-only, pull-never, readiness, shutdown, migration-failure, and backup-binary smoke checks.
- [x] Existing Caddy, kind containers, ports, and unrelated files remain unchanged.
- [x] Secret-free evidence records the commit, commands, bounded results, created container/image names, cleanup, and remaining live-unverified boundaries.

## Safe stop rules

Stop if SSH identity changes, disk headroom becomes unsafe, a command would inspect credentials or environment values, a required port conflicts with an existing listener, or validation would mutate an unrelated service. Remove only resources carrying the Tracegarden validation run identifier.

## Answer

Validated run `tracegarden-validation-21-20260902T074817Z-30845` on the authorized Ubuntu ARM64 VM from clean tested implementation commit `3240952e49dca28474584d8e8158223705bcb791` (tree `0fc3d8ccddc86e2bfd9612ca73d822feaba54e8d`). The archive contained 186 tracked paths; remote pre/post object manifests matched exactly. Native ARM64 kubeconform v0.6.7/no-shim, pinned Node 26.8.1, pnpm 11.9.0, and the exact pinned PostgreSQL/Node images were used. Full ARM64 `pnpm acceptance` passed with complete acquisition-plus-SQL readiness deadlines, deterministic delayed/hanging-connect and late-client cleanup tests, real PostgreSQL integration, browser acceptance, and ARM64 production lifecycle smoke. Acceptance exited 0 and ended `Tracegarden local acceptance workflow passed; no external integrations were contacted.`

Run resources and root-owned generated files were removed through bounded, run-scoped cleanup. Caddy, kind, existing listeners, unrelated exited containers, pinned base images, and the system Node/Corepack installation remained unchanged. Public tooling/browser/runtime downloads were named in the run record before acceptance; no application dependencies or manifests were changed. Metadata was amended only in this issue and `evidence/21-vm-runtime/report.md` after the successful run, with explicit tested-code equivalence; no untested runtime-bearing hash is claimed. Evidence is in `evidence/21-vm-runtime/report.md`. Status remains claimed pending fresh review.
