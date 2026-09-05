# 21: Prove the ARM64 VM runtime baseline

**What to build:** A maintainer can reproduce the accepted Tracegarden workflow and production container lifecycle on the authorized ARM64 VM without using external integrations or Kubernetes.

**Blocked by:** None.

**Status: resolved**

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

The current runtime baseline is resolved by bounded run `tracegarden-validation-21-20260905T002916Z-31881` against the exact current `main` archive of commit `e78d7365346315accccce4bc240ca3e2c7241b3d` (tree `646b479ba93709bd3747289f088ad4d29eb36234`). The clean tracked archive contained 299 entries and matched its remote path manifest. It was validated on the authorized Ubuntu ARM64 VM with Node `v26.8.1` and pnpm `11.9.0` as the host validation toolchain, Bun `1.4.0` as the production runtime, PostgreSQL `18.3`, native kubeconform `v0.6.7`, and strict checked-in schema locations. Full `CI=true pnpm acceptance` passed all 20 sequential stages and exited `0`; production and preview render counts were 20 and 17, with 14 canonical checked-in Kubernetes schemas provisioned.

The prior `3240952e49dca28474584d8e8158223705bcb791` run remains explicitly historical evidence in the report and is not presented as proof of the current runtime. The current run's four Bun production image builds and web/collector/migration/backup lifecycle checks passed under bounded pull-never, non-root, read-only controls. Run-owned files, images, containers, networks, volumes, and the Helm helper image were removed. Existing Caddy, kind node containers, and listeners retained their exact identities and running state. No external integrations, Kubernetes API, Cloudflare, Google, GitHub, R2, production deployment, or credential store was contacted.

Primary evidence: [current sanitized VM transcript](../../../evidence/21-vm-runtime/vm-transcript.txt) and [current report](../../../evidence/21-vm-runtime/report.md).
