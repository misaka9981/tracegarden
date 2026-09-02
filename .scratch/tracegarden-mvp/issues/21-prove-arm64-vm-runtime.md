# 21: Prove the ARM64 VM runtime baseline

**What to build:** A maintainer can reproduce the accepted Tracegarden workflow and production container lifecycle on the authorized ARM64 VM without using external integrations or Kubernetes.

**Blocked by:** None.

**Status:** ready-for-agent

- [ ] The exact reviewed `main` commit is transferred to `ubuntu@161.33.30.111` without copying Git credentials, local secrets, build caches, or unrelated files.
- [ ] The VM records Ubuntu, ARM64, CPU, memory, disk, Docker, Node, Corepack, Helm, and Git metadata without exposing environment values or credential stores.
- [ ] The project-pinned package manager and Node 26.8.x run in a user-owned or containerized boundary; system Node and unrelated services are not replaced.
- [ ] `pnpm acceptance` passes on the VM using only locally materialized pinned images and dependencies; any required public downloads are named and recorded before execution.
- [ ] Production web, collector, migration, and backup images build for ARM64 and pass non-root, read-only, pull-never, readiness, shutdown, migration-failure, and backup-binary smoke checks.
- [ ] Existing Caddy, kind containers, ports, and unrelated files remain unchanged.
- [ ] Secret-free evidence records the commit, commands, bounded results, created container/image names, cleanup, and remaining live-unverified boundaries.

## Safe stop rules

Stop if SSH identity changes, disk headroom becomes unsafe, a command would inspect credentials or environment values, a required port conflicts with an existing listener, or validation would mutate an unrelated service. Remove only resources carrying the Tracegarden validation run identifier.
