# 18: Declare isolated Preview Environments and pull-based promotion

**What to build:** Maintainers can review the declared lifecycle for isolated non-draft pull-request previews and promote immutable production digests through pull-based GitOps. The configuration is complete and verifiable offline while real GitHub, Cloudflare, Argo CD, and Cluster writes remain deferred.

**Blocked by:** 03: Manage Invitations, Members, and roles; 17: Enforce the CI and immutable delivery contract.

**Status:** resolved

- [x] Each eligible non-draft pull request declares a unique Preview Environment with its own namespace, application instances, temporary PostgreSQL database, and seeded non-production data.
- [x] Preview declarations never mount production data or production credentials.
- [x] Preview resource requests, limits, and admission behavior cause capacity exhaustion to fail the preview without consuming production reservations.
- [x] Closing a pull request or converting it to draft removes the Preview Environment, with orphan reconciliation for missed lifecycle events.
- [x] Preview identity is accepted only after validating the configured Cloudflare Access JWT issuer and audience; arbitrary proxy headers are rejected.
- [x] Production promotion selects a release commit, records immutable image digests, requires protected-environment approval, and proposes a reviewable GitOps desired-state update.
- [x] Argo CD pulls desired state; CI configuration does not push directly to a Cluster or receive a cluster-admin credential.
- [x] ApplicationSet and promotion declarations render or validate offline, and live external behavior is clearly marked unverified.

## Answer

Resolved. Current declarations and offline tests cover per-PR namespaces, workloads, temporary seeded PostgreSQL, production-data/credential isolation, bounded non-preempting admission, lifecycle and orphan cleanup, signed Cloudflare Access issuer/audience/header checks, immutable approved promotion, pull-based GitOps, and no direct Cluster mutation. `pnpm preview:validate`, `pnpm delivery:policy`, `pnpm test:chart`, `pnpm chart:validate` (19 valid resources), `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm format:check` passed offline. Live GitHub, Cloudflare, Argo CD, registry, and Kubernetes behavior remains unverified; no external access or writes were performed.
