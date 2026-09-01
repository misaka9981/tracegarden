# 17: Enforce the CI and immutable delivery contract

**What to build:** Every pull request and release candidate receives repeatable evidence for code, persistence, browser behavior, containers, deployment declarations, and supply-chain posture. CI can publish immutable artifacts but never receives direct Cluster credentials.

**Blocked by:** 16: Render the production Kubernetes deployment safely.

**Status:** resolved

- [x] Pull requests run frozen install, formatting, linting, strict typecheck, domain tests, deterministic collector tests, PostgreSQL integration tests, web build, and Playwright smoke tests.
- [x] CI builds and smoke-tests the non-root web and collector images and validates rendered Kubernetes manifests offline.
- [x] Workflow permissions are explicitly least-privilege and third-party actions are pinned to immutable commit revisions.
- [x] Selected dependency, image, secret-pattern, and supply-chain checks fail the workflow on actionable findings.
- [x] Published images use commit-SHA tags and immutable digests rather than mutable deployment tags.
- [x] Release builds produce an SBOM and provenance attestation tied to the selected commit and artifacts.
- [x] No workflow contains, requests, prints, or depends on a cluster-admin kubeconfig or other direct Cluster credential.
- [x] Remote publication remains configuration-only until the intended private repositories and authorized GitHub identity are explicitly supplied.

## Implementation

Added the immutable-pinned CI workflow, offline delivery policy check, gated GHCR publication with commit-SHA tags/digests and SBOM/provenance, digest-pinned PostgreSQL smoke fixtures, native ARM64 jobs, digest-pinned offline manifest/CVE tools, and migration URL/schema-failure assertions. Kubernetes 1.31 strict schemas are checked in as a SHA-256-verified bundle before network-disabled kubeconform runs; Compose smoke exports local image IDs separately from publication registry digests. Publication evidence is retained as a secret-free artifact. No remote workflows or credentials were used.

## Answer

Resolved after review. The final CI diff has no review findings; policy, checksum, chart, network-disabled kubeconform, container smoke, lint, typecheck, format, YAML, and no-staged-file checks passed. No remote workflow, registry write, or Kubernetes access was performed.
