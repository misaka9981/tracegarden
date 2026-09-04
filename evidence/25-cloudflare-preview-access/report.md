# Ticket 25 — Cloudflare Preview Access

**Status: needs-info**

## Run

The free personal-use profile was exercised with disposable Cloudflare `workers.dev` Workers and a run-only Caddy origin route. No production resource or existing Caddy/kind container was replaced. The run was `20260904-121248`; all run resources were removed after the bounded checks.

The workers.dev hostnames used during the run were:

- OAuth: `tracegarden-25-oauth-20260904-121248.misaka9981.workers.dev`
- Preview: `tracegarden-25-preview-20260904-121248.misaka9981.workers.dev`
- Probe: Worker name `tracegarden-25-probe-20260904`; hostname `tracegarden-25-probe-20260904.misaka9981.workers.dev`; recorded Wrangler deploy exited `0` and the initial host probe returned `200`.

The disposable Access application had ID `471bde58-ff33-4b3f-92b1-72defef3ce71`, issuer `https://misaka9981.cloudflareaccess.com`, and AUD `65e8e9f69145ef28c316121d5efad1e0f0998ee5c4ce021ae8a5f496ae764490`. Its allow policy had ID `4a52106e-00e4-4741-a317-2227825a1975`. The policy used the email held in the VM credential file; the email was not recorded.

## Credential boundary

The authorized VM file `/home/ubuntu/tracegarden-credentials/cloudflare.env` was checked before use:

- owner: `ubuntu`
- mode: `0600`
- exactly five allowlisted, non-empty names: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_TEAM_NAME`, `WORKERS_SUBDOMAIN`, and `CLOUDFLARE_ACCESS_ALLOWED_EMAIL`
- no value was printed, logged, committed, or copied into evidence

The account and token verification API calls returned success. The account Access-organization metadata endpoint returned `403`, but the scoped disposable Access application and its policy were successfully created and later removed; no existing application was enumerated or changed.

## Attested bounded behavior

- Both run-labelled Workers deployed through pinned Wrangler `4.129.0` and stored the origin secret in the Worker secret store.
- The origin was `tracegarden-25-20260904-121248.161.33.30.111.sslip.io`, routed by a temporary Caddy block to the run-labelled Preview web NodePort.
- Direct origin `/health/live`: no origin header `403`; wrong origin header `403`; correct run header `200`.
- OAuth Worker `/health/live`: `200`.
- Preview Worker `/health/live` without an Access session: `302` to the Access login boundary.
- At the application boundary, requests with missing, malformed, expired, wrong-issuer, wrong-audience, wrong-signature, and spoofed identity headers each returned `401` when sent through the correct origin secret.
- The Preview namespace was `tracegarden-25-20260904-121248`. PostgreSQL used an emptyDir run-local database, migration completed, and the Preview web workload became ready. No production Secret, PersistentVolume, database, or production image was used; the web pod had `readOnlyRootFilesystem=true` and only run-local temporary/emptyDir volumes.
- A full valid Access admission, bootstrap-subject capture, authenticated SSE stream, and browser OTP completion were not claimed because Access requires one interactive login for the configured identity.

## Cleanup and preservation

- Worker deletion: OAuth `200`, Preview `200`, and probe Worker `tracegarden-25-probe-20260904` `200`; post-delete probes for all three named hostnames returned `404`.
- Access application deletion: `202`; bounded follow-up GETs for the application and policy returned `404`.
- Namespace deletion: absent after the bounded wait.
- Caddy source restored from the pre-run backup, validated, and reloaded; the temporary origin host was absent afterward.
- Both deleted Worker hostnames returned `404` after bounded post-cleanup probes.
- `railgun-caddy`: ID `26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75`, running before and after.
- `k8s-cluster-v137-control-plane`: ID `d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc`, running before and after.
- `k8s-cluster-v137-worker`: ID `ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e`, running before and after.
- Temporary Caddy backup, origin secret, Kubernetes namespace, all three Workers, Access application/policy, and run files were removed. No production deployment occurred.

## Remaining manual action

Ticket 25 remains `needs-info`. Open the Preview Worker URL during a future bounded run, complete the Cloudflare Access OTP login for the configured test identity, then provide only confirmation that the login succeeded. Do not provide the OTP, JWT, cookie, email address, or any secret. The run must then verify valid identity admission, bootstrap subject, authenticated SSE, and final cleanup; the Workers and Access resources were intentionally deleted rather than left running.

## Commands and validation

- Authorized SSH with `BatchMode=yes`, `IdentitiesOnly=yes`, `ConnectTimeout=10`, and server-alive bounds: passed.
- Credential owner/mode/allowlist check: passed.
- Cloudflare account/token/subdomain/API checks: passed; Access organization endpoint was `403` and was not treated as ready.
- Pinned Wrangler Worker deploy, secret storage, health probes, deletion of OAuth/Preview/probe Workers, and post-delete `404` checks: passed.
- Cloudflare Access application/policy create, metadata capture, delete, and post-delete `404` checks: passed.
- Disposable kind namespace, immutable published web/migrate/collector images, PostgreSQL/migration, readiness, and cleanup: passed.
- Direct-origin secret boundary and invalid application JWT/header partition probes: passed.
- Caddy validate/reload, exact restoration, hostname unavailability, and Caddy/kind identity preservation: passed.
- Local report format, link, diff, and secret-safe scans: passed.

## Residual boundary

The provider and origin automation is proven, but the interactive Access identity and authenticated SSE path remain unverified. Ticket 25 must not be marked resolved until that one browser action and the bounded follow-up checks are completed.
