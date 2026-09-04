# Ticket 25 — Cloudflare Preview Access

**Status: resolved**

## Profile and bounded run

This ticket is resolved for the free personal-use profile: a Cloudflare `workers.dev` Preview Worker, Cloudflare Access, and an authenticated Worker-to-origin route to a disposable Preview namespace. It does not claim an owned production DNS zone, production Tunnel, production deployment, or production promotion.

The final run was `20260904-124522-1049820`. The active Preview hostname was:

- `tracegarden-25-preview-20260904-124522-1049820.misaka9981.workers.dev`

Run-labelled OAuth and probe Worker candidates were already absent at final preflight (`404`); the active Preview Worker was deleted during final cleanup (`200`). Post-cleanup probes for all three run-labelled hostnames returned `404`.

The disposable Access application used issuer `https://misaka9981.cloudflareaccess.com` and a run-captured application audience. Its identifiers and policy identifier were retained only as public metadata in the earlier bounded setup record; no token, cookie, email, assertion, or secret value is retained here. The configured allow identity was held only in the VM credential file.

## Credential and isolation boundary

The authorized VM credential file was checked before use:

- owner: `ubuntu`
- mode: `0600`
- only the five allowlisted Cloudflare setup names were used
- no credential value was printed, logged, committed, or copied into evidence

The origin secret was run-scoped, high-entropy, and supplied only through the Worker secret store and temporary Caddy configuration. It was never written to Git or retained in evidence. The Preview namespace used run-local PostgreSQL and emptyDir storage only; no production Secret, PersistentVolume, database, or workload was used.

## Authenticated provider and application behavior

The final same-browser live check retained only booleans, status classes, and safe path categories in [cleanup-transcript.txt](cleanup-transcript.txt):

- Access assertion, authorization cookie, and Access-cookie parsing were present.
- An untrusted identity header was detected at the edge and removed before origin forwarding; the signed `Cf-Access-Jwt-Assertion` was retained.
- Application authentication, HTML marker, content type, and capture probe all succeeded with `2xx`; the application location category was `none` (no login redirect).
- Direct origin requests without or with the wrong origin secret returned `403`; the correct run-scoped secret returned `200`.
- Preview access without an Access session returned `302` to the Access boundary.
- Missing, malformed, expired, wrong-issuer, wrong-audience, wrong-signature, and spoofed-identity-header application JWT partitions returned `401`.

The strict application-side Access check passed without retaining protected values: JWT shape, RS256 algorithm, issuer, audience, subject, expiry, signature, captured-subject equality, and the final validity result were all true. The bootstrap subject was derived internally from the validated assertion and injected only into the disposable workload.

## SSE and notification behavior

The real authenticated Worker path returned `2xx` with `text/event-stream`. The final live check observed the initial `ready` event, a committed run-owned Timeline event after the notification trigger, and a successful reconnect. The notification endpoint returned `2xx`; no event body, row content, identity value, JWT, cookie, or secret was retained.

Two run-only defects found during the bounded exercise were corrected without changing the production protocol: the Worker removed Cloudflare-provided untrusted identity headers before forwarding, and the diagnostic SSE parser recognized an event line followed by its data line. The notification helper was corrected to use `kubectl get pods -o name`, avoiding JSONPath escaping ambiguity. These changes were disposable harness/Worker changes, not production repository changes.

## Cleanup and preservation

The sanitized final transcript records each result. In summary:

- The active Preview Worker deletion returned `200`; OAuth/probe candidates were already `404` and all three hostnames were `404` after cleanup.
- Access application deletion returned `202`; the policy was already removed/cascaded (`404`), and bounded post-delete checks for both returned `404`.
- The run-owned capture process stopped and was reaped; the run-labelled kind namespace deletion returned `0` and the namespace became absent within the bounded wait.
- Caddy was restored from the pre-run source, validated, and reloaded successfully. The temporary origin route was absent afterward, including its temporary secret and backup file.
- The run directory and its temporary files were removed.
- `railgun-caddy` and both existing `k8s-cluster-v137` node containers retained their exact IDs and `running=true` state before and after the run.

No production deployment, production DNS/Access mutation, GitOps mutation, or existing Caddy/kind workload replacement occurred.

## Validation

- Authorized SSH used bounded connection and command timeouts.
- Strict Access signature/issuer/audience/expiry validation passed.
- Direct-origin secret boundary, invalid JWT partitions, authenticated application, SSE ready/timeline/reconnect, and committed notification probes passed.
- Final cleanup, hostname unavailability, namespace absence, Caddy restoration, and Caddy/kind preservation checks passed.
- The repository checks for formatting, links, diff cleanliness, and secret-safe evidence were run after this report update.

## Residual boundary

This proves the disposable free `workers.dev` provider profile and authenticated Preview ingress, including real SSE behavior and cleanup. It does not prove Google OAuth (Ticket 24), off-VM object-storage backup/restore (Ticket 27), target-CNI compatibility (Ticket 29), an owned production DNS/Tunnel profile, or production deployment/promotion. Those remain separate tickets/boundaries.
