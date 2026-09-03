# 10: Reprove the modernized stack

**What to build:** Produce one bounded acceptance record showing that Hono server views and all Bun production processes preserve Tracegarden's existing behavior on local, ARM64 VM, and authorized kind environments.

**Blocked by:** 09: Consolidate Bun production delivery.

**Status:** resolved

- [x] `pnpm acceptance` passes from a clean checkout with the declared development toolchain.
- [x] ARM64 VM acceptance proves exact Bun versions, non-root/read-only images, PostgreSQL behavior, browser/core loop, migration, backup binaries, manifests, and cleanup.
- [x] Authorized kind evidence proves web/collector/migration readiness, list/watch/checkpoint/relist behavior, Hono health/SSE behavior, and cleanup without touching unrelated resources.
- [x] Browser evidence preserves all routes, bilingual UI, auth/admission/capabilities, Timeline, Experiments, Correlations, logs, membership, redirects, and error partitions.
- [x] Evidence distinguishes local/live proof from still-unverified Google, Cloudflare, GitHub/GHCR, object-storage, production-CNI, and production-promotion boundaries.
- [x] A fresh Sol medium review finds no unsupported compatibility or migration claim.

## Answer

The integrated modernized stack passed the final bounded ARM64 VM acceptance from a clean archive of `b154d5a8b6364f76a14a0d5b83158c32f07baff5` (tree `8194a9da89c1fed009ffee870190a983ff07666e`), with the acceptance process reporting Node `v26.8.1` before execution. All 20 sequential stages passed, including Bun compatibility and all four Bun production images, PostgreSQL, browser/core-loop, migration, backup binaries, manifests, delivery policy, and hardened container smoke. The complete sanitized transcript records the run and the final metadata-only path comparison in `evidence/10-modernized-stack/`.

Authorized kind behavior is evidenced by the run-labelled predecessor gates `evidence/05-bun-web/`, `evidence/06-collector-bun/`, `evidence/07-bun-migrations/`, `evidence/22-kind-kubernetes/`, and `evidence/23-kind-argocd/`. This final VM-only run did not touch kind. Those records prove the real Bun web, collector, and migration entrypoints, health/readiness, Hono/SSE, list/watch/checkpoint/relist, cleanup, and preservation boundaries without claiming a fresh broad cluster mutation.

Google OAuth, Cloudflare Access, GitHub/GHCR publication, object storage/off-VM restore, production CNI, Argo production reconciliation, and production promotion remain explicitly unverified and unauthorized. PostgreSQL, `pg`, pnpm, TypeScript, and Node Playwright validation remain unchanged. No external providers, credential stores, or protected values were contacted. The final metadata commit differs from the tested runtime commit only at this issue file, the acceptance report, and the sanitized VM transcript; no runtime-bearing path was changed.

## Safe stop rules

Do not contact third-party providers or production resources. Do not resolve while any predecessor, cleanup, or evidence state is incomplete.
