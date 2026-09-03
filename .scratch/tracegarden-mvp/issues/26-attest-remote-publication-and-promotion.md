# 26: Attest immutable GitHub publication and pull-based promotion

**What to build:** One authorized release commit publishes exact GHCR digests with post-gate attestations and produces a reviewed GitOps promotion consumed by the disposable Argo CD destination.

**Blocked by:** 23: Prove Argo CD reconciliation and Preview Environment cleanup on kind.

**Status:** resolved

- [x] Explicit authorization names the public source repository, GHCR namespace, protected environment, private GitOps repository/branch, and disposable Argo destination.
- [x] Required checks pass for one recorded commit before publication.
- [x] Web, collector, migration, and backup images publish with commit-SHA tags and immutable digests; exact digests pass smoke/CVE gates before SBOM/provenance attachment.
- [x] Preview publication emits digest-only values and the disposable Cluster runs those exact digests.
- [x] Promotion creates a reviewable GitOps proposal containing all four attested digests; CI receives no kubeconfig and performs no direct Cluster mutation.
- [x] After authorized review, Argo CD pulls the approved disposable desired state and reports the expected revision Synced/Healthy.
- [x] Production mutation occurs only after a separate explicit production-promotion authorization; no production mutation was performed, so production promotion remains unverified.

## Safe stop rules

Do not inspect organization secret stores, bypass protections, force-push, grant CI a kubeconfig, overwrite mutable deployment tags, or promote fixture digests.

## Answer

Evidence is retained at `evidence/26-remote-publication/report.md`. The successful runtime/publication source is `6ee9a5f33fc16541fe0054dec29bd682075816e2`, release workflow `33808214530`, publication job `100824381992`, and promotion job `100825286771`. The annotated `v0.1.0` release/tag points to that source. The four exact image digests, SPDX/SLSA attestation counts, GitOps PR #1 (`https://github.com/misaka9981/tracegarden-gitops/pull/1`, base `main`, head `e779a421e8065187ea8bf3701573d61c83f2e9c3`), disposable ApplicationSet reconciliation, cleanup, and preserved Caddy/kind identities are recorded there. The PR remains open and no production deployment was performed.
