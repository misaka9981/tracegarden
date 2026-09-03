# Delivery

## Repository ownership

Remote repositories will belong to the GitHub account `misaka9981`. The application repository is public and the GitOps repository is private. No remote repository is created during the design phase, and no command may silently use the currently active company GitHub identity.

## CI

Pull requests run required checks before they are eligible for preview or merge:

1. Frozen pnpm install.
2. Formatting and lint checks.
3. TypeScript typecheck.
4. Unit and deterministic collector tests.
5. PostgreSQL migration and repository integration tests.
6. Web build and Playwright smoke tests.
7. Non-root production container builds for web, collector, migration, and backup.
8. Helm render and Kubernetes schema validation.
9. Dependency, image, secret-pattern, and supply-chain checks selected during implementation.

Actions receive explicit least-privilege permissions and third-party actions are pinned to immutable commits. Built images use commit-SHA tags and immutable digests; release builds also produce an SBOM and provenance attestation. The ARM64 container and publication jobs use native ARM runners; Helm, kubeconform, and Trivy run from digest-pinned images. Manifest checks first verify and extract the checked-in Kubernetes 1.31 strict schema bundle, then pass its local path to network-disabled kubeconform. High and critical CVEs fail the image job, whose reports are retained as an artifact. The repository workflow keeps GHCR publication configuration-only: its `publish` job runs only when the repository variables `ENABLE_GHCR_PUBLICATION=true` and `GHCR_NAMESPACE` are explicitly configured, and it uses the short-lived `GITHUB_TOKEN` with package and attestation permissions only. `GHCR_NAMESPACE` must be the lower-case intended private owner. Publication builds web, collector, migration, and backup with Buildx provenance/SBOM disabled before the shared exact-digest smoke/CVE gate; backup is smoke-tested as a non-root read-only process that fails closed without backup configuration. Each exact pushed digest, including `backup_digest`, is scanned with the same high/critical `--ignore-unfixed` policy, then Trivy generates its SPDX SBOM and pinned `actions/attest-sbom` plus `actions/attest-build-provenance` attach both attestations only after the gate passes. Publication retains digest, SBOM, and provenance metadata plus immutable image manifests as an artifact without application secrets. A separately guarded `preview-publish` job performs the same digest handoff for PRs and emits a reviewable `deploy/preview/digests/pr-{number}.yaml` value file plus metadata declaration; it never mutates PR labels or remote Git state.

## Pull-request previews

Every non-draft pull request receives one Preview Environment:

- When `ENABLE_PREVIEW_PUBLICATION=true`, GitHub Actions builds preview images and publishes them to private GHCR by digest; the default remains deferred.
- The CI artifact records actual image digests as a digest-only Helm value file. A maintainer/operator must commit that exact file to the protected `tracegarden-gitops` repository `main`; ApplicationSet reads only that protected revision, while PR number/metadata is lookup-only. Missing value files fail closed and CI performs no remote write.
- The administrator-installed Argo CD AppProject admits only the trusted preview source, `preview-pr-*` destinations, and an allowlist of namespaced kinds. The lifecycle controller creates each destination namespace before eligibility; the fixed chart cannot create cluster-scoped resources.
- Argo CD ApplicationSet consumes the committed per-PR value file from protected GitOps `main` for open pull requests. An operator-installed lifecycle CronJob provisions each namespace, fixed GHCR pull Secret, and fixed ServiceAccount before adding the eligibility label; it maintains the non-draft preview label, reconciles draft/closed/rejected/orphan namespaces every minute, and deletes them within the documented 120-second request bound.
- Each preview has its own namespace, application instances, temporary PostgreSQL database, and seeded non-production data.
- Production data and credentials are never mounted into a preview namespace.
- Cloudflare Access protects preview ingress. The application validates the Access JWT before accepting preview identity.
- Resource requests and limits protect the four-core VM. A declared aggregate preview admission budget rejects exhausted previews rather than evicting protected production; preview pods use a lower, non-preempting PriorityClass.
- Closing or converting the pull request to draft removes the environment. An orphan reconciliation policy handles missed cleanup events.

Dynamic Google redirect URIs are not created for previews. Production uses application-level Google OAuth; previews validate the separate Cloudflare Access identity path.

## Production promotion

1. A version tag or GitHub Release selects an application commit.
2. CI rebuilds and tests the commit, pushes web, collector, migration, and backup images to GHCR, and records immutable digests.
3. A protected GitHub Environment requires explicit approval.
4. CI emits a complete, reviewable desired-state patch artifact tied to that protected workflow run, including `backup_digest`; remote GitOps PR creation remains deferred.
5. Merging that promotion change updates desired state.
6. Argo CD runs the database migration job and then reconciles workloads.

GitHub Actions never receives a cluster-admin kubeconfig. Argo CD pulls desired state from Git. Automatic pruning and self-healing are configured deliberately per environment rather than assumed.

## Deployment topology

Production contains separate web and collector Deployments, PostgreSQL persistent storage, a one-shot migration Job, Services, Ingress, NetworkPolicies, ServiceAccounts, scoped RBAC, resource limits, and startup/readiness/liveness probes. The initial application UI supports one Cluster connection while schemas retain `clusterId` for later expansion.

## External setup left for later authorization

- Create the two private repositories under `misaka9981`.
- Configure GHCR and GitHub Environment protections.
- Install or configure Argo CD on the personal cluster, then install the operator-managed preview lifecycle controller and its GitHub/GHCR Secrets.
- Configure Cloudflare DNS, TLS, Access, and optional Tunnel.
- Register production Google OAuth redirect URIs.
- Provide a kubeconfig context that unambiguously targets the personal cluster.

These operations change external systems and are not implied by local scaffolding.
