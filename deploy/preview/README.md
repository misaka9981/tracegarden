# Preview and promotion declarations

## ApplicationSet schema provenance

`applicationset-crd.yaml` is the vendored Argo CD `ApplicationSet` CRD from
release `v3.4.6`. It was downloaded from the official release path
`https://raw.githubusercontent.com/argoproj/argo-cd/v3.4.6/manifests/crds/applicationset-crd.yaml`.
The offline delivery test extracts the `v1alpha1.schema.openAPIV3Schema` from
that CRD directly; no network or Kubernetes access is used during validation.

`appproject.yaml` is the administrator-installed trust boundary: only the
repository's preview chart, `preview-pr-*` destinations, and the chart's
allowlisted namespaced kinds are admitted. The lifecycle controller creates
only the exact `preview-pr-*` destination namespace; the chart cannot create
namespaces.
`applicationset.yaml` is the pull-request entry point. Its supported GitHub PR
generator observes open pull requests carrying the operator-maintained
`tracegarden.dev/preview` label, then renders the reviewed chart at
`environments/previews/chart` and immutable
`environments/previews/digests/pr-{number}.yaml` from protected `main`.
The PR number selects the file only; neither chart nor value content comes from
`head_sha`. Missing or incomplete value files fail closed, so a preview cannot
fall back to a tag, an empty digest, or an unconfigured identity.

`preview-artifact.mjs` writes the digest-only value file and its metadata declaration
to the CI artifact. A maintainer/operator must commit that file to protected
`tracegarden-gitops` `main` (or an authorized protected GitOps branch) before Argo can consume it; CI does not
write GitHub labels or Git state. `lifecycle-controller.yaml` is installed by the
operator and runs a CronJob every minute. It reads operator-managed GitHub PR
state, admits only previews within the executable aggregate budget, provisions
the fixed image-pull ServiceAccount and copied GHCR pull Secret, and deletes
closed, draft, rejected, and orphan namespaces. The Secret is used only as
PodSpec `imagePullSecrets`; the fixed ServiceAccount has no credential mount or
pull-secret binding. Its GitHub token is operator-managed and must have read
access to pull requests and protected GitOps digest files, plus the narrow label
permission required to maintain `tracegarden.dev/preview`;
the operator must create that repository label, and no PR workflow receives the
token.
The documented reconciliation bound is 120 seconds; live controller and API
behavior remains unverified here.

The preview chart creates only namespaced, temporary resources: web and
collector Deployments, an `emptyDir` PostgreSQL StatefulSet, a migration Job,
and a non-production seed Job. Cloudflare Access issuer, audience, and
signing/bootstrap configuration are fixed in the protected chart; missing
configuration leaves the preview failed closed. A ResourceQuota
and LimitRange are admission boundaries; the lifecycle policy also declares an
aggregate preview budget and protected production reservation. Every pod has explicit requests/limits,
`priorityClassName: tracegarden-preview`, and `preemptionPolicy: Never`, so a
full preview budget fails admission instead of preempting production workloads.
No production Secret or volume is referenced.

Cloudflare Access is represented by the signed `cf-access-jwt-assertion`
contract. The application must verify that JWT's signature and configured
issuer/audience; identity must not be derived from email or other arbitrary
proxy headers. `NODE_ENV=preview` fails closed unless the issuer, audience,
and public key are all configured. The configured issuer and audience are
operator-managed configuration, not PR values or credentials.

`deploy/promotion/promotion.yaml` records the release commit, digest-pinned web,
collector, migration, and backup images, protected production approval
requirement, and GitOps pull-request requirement. CI emits a complete,
reviewable desired-state artifact with the gated `backup_digest`; remote GitOps
PR creation remains deferred. Preview carries the immutable backup digest for
publication handoff but has no backup workload; production chart values select
no backup image. Supply the attested release digest through trusted desired
state before enabling or promoting backup. `deploy/gitops/production/application.yaml`
declares Argo CD's pull source. Live GitHub, Cloudflare, Argo CD, registry, and
Cluster behavior remain **unverified** until authorized infrastructure is
provided.
