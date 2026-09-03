# Ticket 26: remote publication and pull-based promotion

**Status:** resolved

The sanitized command/result record is retained at `evidence/26-remote-publication/remote-transcript.txt`.

## Scope and authorization

- The authorized source repository was the public `misaka9981/tracegarden`; `main` was pushed without force-push.
- The authorized release was the annotated tag and GitHub Release `v0.1.0`.
- Publication was limited to `ghcr.io/misaka9981/tracegarden-{web,collector,migrate,backup}`.
- The authorized GitOps repository is private `misaka9981/tracegarden-gitops`, with an explicit `main` base branch.
- Cluster work was limited to the disposable ARM64 kind context `kind-k8s-cluster-v137` on the authorized VM. No production Cluster, Cloudflare, Google OAuth, object storage, or production promotion was touched.
- The protected environment approval was performed through the normal `Xinyuan-chen0115` reviewer path. No protection or credential boundary was bypassed.

## Source and release

- Runtime/publication source commit: `6ee9a5f33fc16541fe0054dec29bd682075816e2`.
- Main CI workflow `33807930635` completed successfully for that source. The release workflow's offline policy, Helm/schema, frozen install/domain, PostgreSQL, browser, container/CVE, and supply-chain jobs all completed successfully before publication.
- `v0.1.0` was recreated once after the final pre-release validation and points to `6ee9a5f33fc16541fe0054dec29bd682075816e2` both locally and on `origin`. It is the only release/tag recreation in this final successful attempt; no force-push or mutable tag was used.
- Release workflow: `33808214530`.
- Protected publication job: `100824381992`, approved normally through environment `production` (`21157164002`).
- The final post-release metadata commit contains only this report and Ticket 26 metadata. A `git diff-tree` comparison from the tagged runtime/publication source was checked before push; no runtime-bearing source was changed after the published commit.

## Published immutable images

The publication job pushed commit-SHA tags, pulled the resulting immutable references, ran exact-digest smoke and Trivy HIGH/CRITICAL checks before attestation, and persisted the following matrix:

| image | commit-SHA tag | immutable digest | result |
|---|---|---|---|
| web | `6ee9a5f33fc16541fe0054dec29bd682075816e2` | `sha256:1fd128d55ff7d17cdbbabffa36b3827cc7ab4657a2017952b0584d95c8a142d4` | exact smoke/CVE passed |
| collector | `6ee9a5f33fc16541fe0054dec29bd682075816e2` | `sha256:f893e7d18ceee2137bb8cbfc95beb4f02660c95059d09cca878d9e2cea714eec` | exact smoke/CVE passed |
| migrate | `6ee9a5f33fc16541fe0054dec29bd682075816e2` | `sha256:7d287c17aa9dfadda7121c796d32df07cdf8a7dd5b9b8a451d0dc9c3cbdcd0d0` | exact smoke/CVE passed |
| backup | `6ee9a5f33fc16541fe0054dec29bd682075816e2` | `sha256:dafa999de220c83cbbbc4bb9aea12b0fc237812cdfb2553e1007870cdf1e3180` | exact smoke/CVE passed |

The successful publish job order was: push each image, pull exact digests, smoke-test those digests, scan them for HIGH/CRITICAL vulnerabilities, generate SPDX SBOMs, then attach attestations. Each final digest has one verified SPDX SBOM attestation and one verified SLSA provenance attestation:

| image | SPDX predicate records | SLSA provenance records |
|---|---:|---:|
| web | 1 | 1 |
| collector | 1 | 1 |
| migrate | 1 | 1 |
| backup | 1 | 1 |

The source also retains earlier failed commit-SHA package versions as audit records; they were not deleted or reused. The successful release uses only the matrix above.

## GitHub Actions and promotion artifact

- The relative-path SBOM repair and service-name normalization were validated by main CI `33807930635`; the earlier failed attempts remain in workflow history and were not rewritten.
- The successful publication job `100824381992` completed exact smoke, Trivy, four SPDX SBOM attestations, four provenance attestations, and immutable evidence upload.
- Promotion job `100825286771` completed after the normal protected-environment approval. It created the digest-only promotion artifact with `releaseCommit=6ee9a5f33fc16541fe0054dec29bd682075816e2` and all four digest values above. CI performed no Kubernetes mutation and received no kubeconfig.
- The private GitOps repository was confirmed to use `main` as its default branch and had no existing pull requests. The reviewable PR is [#1](https://github.com/misaka9981/tracegarden-gitops/pull/1), with base `main`, head `promotion/v0.1.0-6ee9a5f`, and head commit `e779a421e8065187ea8bf3701573d61c83f2e9c3`.
- The PR adds `environments/production/tracegarden/desired-state.yaml` from the workflow artifact. It contains only the four immutable GHCR references, the release commit, protected-environment approval reference, `mechanism: pull-request`, and `directClusterMutation: false`. The PR remains open and was not merged.

## Disposable Argo/kind verification

- Official Argo CD v3.4.6 declarations were fetched from `https://raw.githubusercontent.com/argoproj/argo-cd/v3.4.6/manifests/install.yaml`; the retained file was 1,890,752 bytes with SHA-256 `752b5a2681f2522fc78ea12ba2d23be44a4523cfa5d9a55cf1907909cc23fc5d` locally and on the VM.
- Argo was installed only into the previously absent run-owned `argocd` namespace. The private GitOps PR head was mirrored into a run-owned local Git daemon solely to avoid supplying private GitHub credentials to the disposable Cluster. `git ls-remote` verified the mirror's `promotion/v0.1.0-6ee9a5f` at `e779a421e8065187ea8bf3701573d61c83f2e9c3`.
- A run-labelled ApplicationSet using that exact PR revision generated an Application. The generated Application reported:
  - `sync=Synced`
  - `health=Healthy`
  - `revision=e779a421e8065187ea8bf3701573d61c83f2e9c3`
  - `operation=Succeeded`
- The reconciled run-owned `ProductionDesiredState` contained the exact release commit and all four digest references from the successful publication matrix. This proves the PR revision was consumed by the real ApplicationSet controller and reconciled as digest-only desired state in the disposable destination; it does not claim production reconciliation.
- A run-only CRD was used for the fixture custom resource, with unknown fields preserved so the exact `spec.images` values were observable. The initial disposable schema-pruning behavior was corrected before the final sync; no production schema or Cluster resource was changed.

## Cleanup and preservation

All run-owned resources were removed after the successful observation:

- ApplicationSet `tg26-promotion` and generated Application `tg26-promotion` were deleted.
- Destination namespace `tg26-promotion` and fixture CRD `productiondesiredstates.delivery.tracegarden.dev` were deleted.
- Official Argo namespaced resources were deleted from both the temporary default-namespace apply and the run-owned `argocd` namespace; the run-owned `argocd` namespace was deleted.
- Official Argo CRDs, ClusterRoles, and ClusterRoleBindings were checked absent.
- The run-local Git daemon was terminated by its recorded PID, and its repository, archive, manifest, and temporary directories were removed. No run-owned process remained.
- Exact post-cleanup checks confirmed no run ApplicationSet, Application, destination namespace, fixture CRD, Argo namespace, official Argo CRDs, or run-local artifacts remained.
- Before and after cleanup, the existing containers remained unchanged and running:
  - `/railgun-caddy`: `26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75`
  - `/k8s-cluster-v137-control-plane`: `d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc`
  - `/k8s-cluster-v137-worker`: `ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e`
  Each retained `Running=true` and the exact same ID.
- No credentials, tokens, authorization headers, private keys, database passwords, or protected values were written to evidence.

## Residual risks and explicit non-claims

- The GitOps PR is reviewable but intentionally unmerged. No production deployment or production Cluster mutation was performed; separate production authorization remains required.
- The disposable Argo test used an exact PR-head mirror rather than private GitHub credentials. It proves ApplicationSet/controller behavior and exact revision/digest reconciliation, not private-repository authentication or production Argo reconciliation.
- Google OAuth, Cloudflare Access, object-storage upload, off-VM restore, target-CNI NetworkPolicy behavior, and production promotion remain unverified by design.
- Earlier failed publication workflows and their package versions remain retained for audit. They are not release inputs and have no final attestations.
