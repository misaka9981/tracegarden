# Delivery

## Repository ownership

Remote repositories will belong to the GitHub account `MISAKA3389`. Both the application repository and the GitOps repository remain private initially. No remote repository is created during the design phase, and no command may silently use the currently active company GitHub identity.

## CI

Pull requests run required checks before they are eligible for preview or merge:

1. Frozen pnpm install.
2. Formatting and lint checks.
3. TypeScript typecheck.
4. Unit and deterministic collector tests.
5. PostgreSQL migration and repository integration tests.
6. Web build and Playwright smoke tests.
7. Non-root container builds for web and collector.
8. Helm render and Kubernetes schema validation.
9. Dependency, image, secret-pattern, and supply-chain checks selected during implementation.

Actions receive explicit least-privilege permissions and third-party actions are pinned to immutable commits. Built images use commit-SHA tags and immutable digests; release builds also produce an SBOM and provenance attestation.

## Pull-request previews

Every non-draft pull request receives one Preview Environment:

- GitHub Actions builds preview images and publishes them to private GHCR.
- Argo CD ApplicationSet observes eligible pull requests and reconciles the corresponding application.
- Each preview has its own namespace, application instances, temporary PostgreSQL database, and seeded non-production data.
- Production data and credentials are never mounted into a preview namespace.
- Cloudflare Access protects preview ingress. The application validates the Access JWT before accepting preview identity.
- Resource requests and limits protect the four-core VM. Capacity exhaustion fails preview creation rather than evicting production.
- Closing or converting the pull request to draft removes the environment. An orphan reconciliation policy handles missed cleanup events.

Dynamic Google redirect URIs are not created for previews. Production uses application-level Google OAuth; previews validate the separate Cloudflare Access identity path.

## Production promotion

1. A version tag or GitHub Release selects an application commit.
2. CI rebuilds and tests the commit, pushes images to GHCR, and records immutable digests.
3. A protected GitHub Environment requires explicit approval.
4. Automation proposes the digest update in the private GitOps repository.
5. Merging that promotion change updates desired state.
6. Argo CD runs the database migration job and then reconciles workloads.

GitHub Actions never receives a cluster-admin kubeconfig. Argo CD pulls desired state from Git. Automatic pruning and self-healing are configured deliberately per environment rather than assumed.

## Deployment topology

Production contains separate web and collector Deployments, PostgreSQL persistent storage, a one-shot migration Job, Services, Ingress, NetworkPolicies, ServiceAccounts, scoped RBAC, resource limits, and startup/readiness/liveness probes. The initial application UI supports one Cluster connection while schemas retain `clusterId` for later expansion.

## External setup left for later authorization

- Create the two private repositories under `MISAKA3389`.
- Configure GHCR and GitHub Environment protections.
- Install or configure Argo CD on the personal cluster.
- Configure Cloudflare DNS, TLS, Access, and optional Tunnel.
- Register production Google OAuth redirect URIs.
- Provide a kubeconfig context that unambiguously targets the personal cluster.

These operations change external systems and are not implied by local scaffolding.
