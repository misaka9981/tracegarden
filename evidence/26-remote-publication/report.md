# Ticket 26: remote publication and promotion evidence

**Status:** blocked. Two authorized release attempts were retained for audit; no further tag, release, package, or publication attempt was made after the second failure.

## Scope and authorization

- Authorized source: public `misaka9981/tracegarden`; `main` was pushed without force-push.
- Authorized release: annotated `v0.1.0`. It was deleted and recreated once at `91f6425799a5277c445fa4ba1847ed896b9479e5`; it remains at that commit.
- Authorized GHCR names were limited to `ghcr.io/misaka9981/tracegarden-{web,collector,migrate,backup}`.
- Authorized GitOps target was private `misaka9981/tracegarden-gitops`, base `main`. No promotion PR was created because publication did not complete its required attestation gates.
- Only disposable local/ARM64 validation was authorized. No production deployment or production resource was changed.

## Pre-publication gates

- Main commit `01b7803b181f8bbac528adbf525a6053c51dab11` passed CI `33752445261` before the first release attempt.
- The release attempt at `v0.1.0` commit `01b7803b181f8bbac528adbf525a6053c51dab11` was workflow `33753520623`, publication job `100643174029`. Its four image pushes completed, but the exact-digest smoke check failed.
- The root repair was pushed as `91f6425799a5277c445fa4ba1847ed896b9479e5`. Main CI `33755802932` passed all jobs, including container/CVE and manifests. The authorized ARM64 VM passed full `CI=true pnpm acceptance` under Node `v26.8.1` and Bun `v1.4.0`; the exact four-image release Compose smoke also passed twice.
- The final authorized recreation at the repaired commit was workflow `33756528919`. Its prepublish gates, four image pushes, exact-digest smoke, Trivy HIGH/CRITICAL scan, and four SPDX SBOM generation all passed. It then failed at the first SBOM attestation action, so the release is not accepted.

## Published digest identifiers

The first failed run returned these immutable digests:

| image | first-run digest | state |
|---|---|---|
| `tracegarden-web` | `sha256:880c672575e89adb01caf6d832a4fd3f514fc1f6188d02bdb6693bef74d02421` | retained; smoke failed before attestation |
| `tracegarden-collector` | `sha256:c12cebcea4bd4e2c3b946adc0ace7183656244e2e9fedd9b93f18d8f766ca574` | retained; smoke failed before attestation |
| `tracegarden-migrate` | `sha256:28d69732ff30bd37abcd224e4edf9e56308a9c81a3bda7585c73dff239230bdb` | retained; smoke failed before attestation |
| `tracegarden-backup` | `sha256:9e19ebbf66f2f47dc8d72d35951877122c05f45a2e29e0161566441f880d20f6` | retained; smoke failed before attestation |

The final recreation pushed a separate commit-SHA image set and returned:

| image | final-run digest | state |
|---|---|---|
| `tracegarden-web` | `sha256:319d27147ad1bca05e22f38e57acd58b0eb22a1ca3d1219550524cc722305a9b` | exact smoke/CVE/SBOM generation passed; attestation failed |
| `tracegarden-collector` | `sha256:9d12a80d5cd81378d812ea7988c292afb7e4777d9b93777db2e7a94965bf7a3c` | exact smoke/CVE/SBOM generation passed; attestation not reached |
| `tracegarden-migrate` | `sha256:3e0bebc5cca4b4f293b8156153af5be622934e568e8ecbb3f0818a99aabdb9c0` | exact smoke/CVE/SBOM generation passed; attestation not reached |
| `tracegarden-backup` | `sha256:ea6a735a48f27da8abd6a433053e53cd52d9817ff8ebe93985b390f0dbcecc89` | exact smoke/CVE/SBOM generation passed; attestation not reached |

The final workflow returned its digest outputs only to the failed job; the four values above are taken from its exact-digest pull and SBOM command logs. No CVE failure occurred. No SBOM or provenance attestation is claimed because the first attestation action failed. GHCR package versions were not deleted.

## Failures and repairs

### First release attempt: Compose log channel/race

`33753520623` failed at `scripts/container-smoke.mjs:142` with an empty stdout value while expecting `missing backup configuration: DATABASE_URL`. Direct execution of the exact published backup digest and a same-tree local ARM64 build both returned exit `1` and emitted the expected 58-byte stderr message under the release security settings. In the full Compose path, `docker compose logs backup` contained the message while the helper's stdout-only `docker logs` read was empty; the old helper also accepted a not-yet-started `created` container as stopped.

Commit `91f6425799a5277c445fa4ba1847ed896b9479e5` changed the state check to require terminal `exited`/`dead` with a non-zero `StartedAt`, added a deterministic `created -> running -> exited` unit assertion, and used bounded Compose log capture so stderr is included. The exact published four-image Compose smoke passed twice on ARM64.

### Final release attempt: SBOM attestation path/action

`33756528919` passed the repaired exact-digest smoke and Trivy scan. The generation loop passed `test -s` for all four Trivy SPDX files. It failed at `Attest web SBOM` when the deprecated `actions/attest-sbom@c604332...` wrapper invoked `actions/attest@59d894...` and reported:

```text
Error: SBOM file not found
```

The failing input was `/home/runner/work/_temp/tracegarden-release-sbom/web.spdx.json`; the generation step had written under the runner temporary directory and verified it there. This was an attestation path/action boundary failure, not a digest smoke, Trivy, image, or SBOM-generation failure.

Commit `8ffecb8046416db4b038a9e946575dbfd2e64141` (pushed to `main`, no tag movement) changes both preview and release generation to `$GITHUB_WORKSPACE/.scratch/tracegarden-{preview,release}-sbom`, uses the fixed official `actions/attest@59d89421af93a897026c735860bf21b6eb4f7b26` directly, and adds a bounded `test -s` plus `jq` SPDX object/version/ID check before each action. Delivery policy and delivery tests enforce those paths, action references, ordering, and pre-attestation readability checks.

## Current state and boundaries

- No release was rebuilt after `33756528919`; no further tag/release/package mutation is authorized by this run.
- No GitOps branch/PR or Argo reconciliation was created because no final set of attested digests exists.
- No production deployment, Cloudflare, Google OAuth, object storage, or production CNI operation was performed.
- The authorized VM's pre-existing Caddy container and both kind node container identities were preserved. Exact-smoke and acceptance run-owned containers, images, networks, volumes, and temporary directories were cleaned.

## Residual risks

- `v0.1.0` and two commit-SHA image sets exist in GHCR from failed publication attempts; they are retained for audit but are not attested release inputs.
- SBOM/provenance publication, GitOps promotion, disposable Argo digest reconciliation, and production promotion remain unverified.
- A future release requires explicit authorization after this run; this worker must not retag or republish the existing release.
