# 26: Attest immutable GitHub publication and pull-based promotion

**What to build:** One authorized release commit publishes exact GHCR digests with post-gate attestations and produces a reviewed GitOps promotion consumed by the disposable Argo CD destination.

**Blocked by:** 23: Prove Argo CD reconciliation and Preview Environment cleanup on kind.

**Status:** claimed

- [ ] Explicit authorization names the private GitHub repository, GHCR namespace, protected environment, GitOps repository/branch, and disposable Argo destination.
- [ ] Required checks pass for one recorded commit before publication.
- [ ] Web, collector, migration, and backup images publish with commit-SHA tags and immutable digests; exact digests pass smoke/CVE gates before SBOM/provenance attachment.
- [ ] Preview publication emits digest-only values and the disposable Cluster runs those exact digests.
- [ ] Promotion creates a reviewable GitOps proposal containing all four attested digests; CI receives no kubeconfig and performs no direct Cluster mutation.
- [ ] After authorized review, Argo CD pulls the approved disposable desired state and reports the expected revision Synced/Healthy.
- [ ] Production mutation occurs only after a separate explicit production-promotion authorization; otherwise it remains unverified.

## Safe stop rules

Do not inspect organization secret stores, bypass protections, force-push, grant CI a kubeconfig, overwrite mutable deployment tags, or promote fixture digests.

## Needed from the operator

Confirm authorization to create the release/tag and GHCR packages in `misaka9981/tracegarden`, name the protected environment, and provide the authorized GitOps repository/branch. Production approval is separate.

## Outcome

Ticket remains **claimed/blocked**; the observed evidence is retained at `evidence/26-remote-publication/report.md`. The authorized `v0.1.0` recreation at `91f6425799a5277c445fa4ba1847ed896b9479e5` passed prepublication, exact-digest smoke, Trivy, and SPDX generation, but the first direct SBOM attestation failed because the workflow supplied a missing runner-temporary path. The path/action repair was pushed to `main` as `8ffecb8046416db4b038a9e946575dbfd2e64141` and its CI run `33758050814` passed. Per the stop rule, no further tag/release/publication attempt, GitOps promotion, or Argo claim was made; no checklist item is marked complete.
