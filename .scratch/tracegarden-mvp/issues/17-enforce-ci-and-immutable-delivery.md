# 17: Enforce the CI and immutable delivery contract

**What to build:** Every pull request and release candidate receives repeatable evidence for code, persistence, browser behavior, containers, deployment declarations, and supply-chain posture. CI can publish immutable artifacts but never receives direct Cluster credentials.

**Blocked by:** 16: Render the production Kubernetes deployment safely.

**Status:** ready-for-agent

- [ ] Pull requests run frozen install, formatting, linting, strict typecheck, domain tests, deterministic collector tests, PostgreSQL integration tests, web build, and Playwright smoke tests.
- [ ] CI builds and smoke-tests the non-root web and collector images and validates rendered Kubernetes manifests offline.
- [ ] Workflow permissions are explicitly least-privilege and third-party actions are pinned to immutable commit revisions.
- [ ] Selected dependency, image, secret-pattern, and supply-chain checks fail the workflow on actionable findings.
- [ ] Published images use commit-SHA tags and immutable digests rather than mutable deployment tags.
- [ ] Release builds produce an SBOM and provenance attestation tied to the selected commit and artifacts.
- [ ] No workflow contains, requests, prints, or depends on a cluster-admin kubeconfig or other direct Cluster credential.
- [ ] Remote publication remains configuration-only until the intended private repositories and authorized GitHub identity are explicitly supplied.
