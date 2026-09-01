# 18: Declare isolated Preview Environments and pull-based promotion

**What to build:** Maintainers can review the declared lifecycle for isolated non-draft pull-request previews and promote immutable production digests through pull-based GitOps. The configuration is complete and verifiable offline while real GitHub, Cloudflare, Argo CD, and Cluster writes remain deferred.

**Blocked by:** 03: Manage Invitations, Members, and roles; 17: Enforce the CI and immutable delivery contract.

**Status:** ready-for-agent

- [ ] Each eligible non-draft pull request declares a unique Preview Environment with its own namespace, application instances, temporary PostgreSQL database, and seeded non-production data.
- [ ] Preview declarations never mount production data or production credentials.
- [ ] Preview resource requests, limits, and admission behavior cause capacity exhaustion to fail the preview without consuming production reservations.
- [ ] Closing a pull request or converting it to draft removes the Preview Environment, with orphan reconciliation for missed lifecycle events.
- [ ] Preview identity is accepted only after validating the configured Cloudflare Access JWT issuer and audience; arbitrary proxy headers are rejected.
- [ ] Production promotion selects a release commit, records immutable image digests, requires protected-environment approval, and proposes a reviewable GitOps desired-state update.
- [ ] Argo CD pulls desired state; CI configuration does not push directly to a Cluster or receive a cluster-admin credential.
- [ ] ApplicationSet and promotion declarations render or validate offline, and live external behavior is clearly marked unverified.
