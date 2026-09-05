# Tracegarden live-provider setup

This is an operator handoff for Tickets 24, 25, 27, and 29. It records how to prepare disposable resources; it is not an execution log. No cloud, DNS, OAuth, object-storage, Kubernetes, or production mutation is implied by this document.

The recommended personal-use profile uses free Cloudflare `workers.dev` hostnames and does not require purchasing a domain. The owned-domain profile remains available when a production-shaped DNS and Tunnel path is required.

## Safety and ordering

Never put tunnel tokens, API tokens, Google client secrets, R2 secret keys, database passwords, application secrets, encryption keys, JWTs, cookies, OAuth codes, dumps, or full email addresses in chat, Git, or evidence. Create run-scoped files with `umask 077`, use mode `0600`, and report only non-secret identifiers and redacted identity labels.

Use one disposable resource set per run:

1. Prepare Cloudflare account/Workers and Google Cloud access manually.
2. Establish the Ticket 25 HTTPS ingress and Access boundary.
3. Establish the Ticket 24 callback on a separate hostname; do not put Access in front of it unless that interaction is explicitly being tested.
4. Prepare the optional Ticket 27 R2 bucket and separate clean PostgreSQL restore target only when off-site disaster recovery is needed; otherwise keep the backup CronJob disabled and skip its live proof.
5. Run Ticket 29 only in a new disposable kind cluster with pinned Cilium. Never replace the CNI in the existing `k8s-cluster-v137` cluster.

Ticket 24 remains `needs-info` until its required provider resources and cleanup authority are explicitly supplied. Ticket 27 is currently `wontfix` for this personal deployment because off-site disaster recovery is not needed; its implementation and this future runbook remain available if that need changes.

## Profile A: free personal use (recommended)

Cloudflare provides stable HTTPS `workers.dev` hostnames without an owned domain. Use two Workers:

```text
tracegarden-oauth.<account-subdomain>.workers.dev
tracegarden-preview.<account-subdomain>.workers.dev
```

The OAuth Worker is not protected by Access, so Google callback state and cookies are not wrapped in an unrelated Access login. The Preview Worker is protected by Cloudflare Access.

A Worker hostname is not by itself a connection to the VM. The Worker must proxy to a dedicated origin route on the authorized VM. For a no-domain personal setup, use a disposable `sslip.io` origin hostname or another explicitly authorized origin route and require a high-entropy, run-scoped secret header at Caddy. The origin must return `403` for requests without that header or with the wrong value. Do not expose a direct unauthenticated origin and do not use a proxy to bypass Access.

The free profile must live-test streaming/SSE through the Worker, not infer it from a successful health response. During cleanup, remove the Worker route/deployment, Access application/policy, origin route and secret, and any disposable origin resource; preserve unrelated Caddy routes.

`workers.dev` is intended for personal/non-critical use. Workers Free has finite request/CPU quotas, and Access/R2 availability and limits should be checked in the account before a run. Quick Tunnels (`trycloudflare.com`) are not equivalent: their URLs are temporary, have no stable hostname/SLA, and are unsuitable for the persistent callback or SSE proof.

## Profile B: owned domain and Tunnel

For a production-oriented shape, use one Cloudflare-managed owned domain and one named Tunnel with two published hostnames:

```text
app.<owned-domain>
preview-pr-N.<owned-domain>
```

The Tunnel connector runs on the authorized VM. `app` is the OAuth callback hostname and `preview-pr-N` is disposable Preview. Protect only the Preview hostname with Access unless the callback-specific Access behavior is intentionally included. Do not change unrelated DNS records, routes, tunnels, or Caddy configuration.

Full DNS setup requires the registrar to delegate the zone to Cloudflare nameservers. DNSSEC/DS changes and domain ownership remain manual operator actions. A one-off Quick Tunnel is not a replacement for this profile.

## Manual bootstrap versus CLI/API automation

The operator must manually complete account bootstrap and interactive identity steps:

- create/sign in to the Cloudflare account and perform the first `workers.dev` subdomain setup;
- onboard the Zero Trust organization/team and choose the disposable Access identity/provider;
- create least-privilege Cloudflare API tokens and R2 S3 credentials only if the optional Ticket 27 backup is being enabled;
- create the Google Cloud project/client, configure consent/test users, and perform browser consent for controlled identities;
- authorize the VM, local restore target, and cleanup scope.

After bootstrap, a worker may use a pinned Wrangler version and Cloudflare API with a credential file to create, deploy, inspect, and remove only run-labelled resources. Wrangler supports Worker deployment and R2 bucket/lifecycle operations; Access applications and reusable policies use the Cloudflare API. Every command must have a short timeout and must fail closed on an unexpected resource name or status. Do not enumerate unrelated zones, applications, tunnels, buckets, or secrets.

Suggested run-scoped Cloudflare file on the authorized VM:

```text
/home/ubuntu/tracegarden-credentials/cloudflare.env
```

```dotenv
CLOUDFLARE_API_TOKEN=<0600-file-only>
CLOUDFLARE_ACCOUNT_ID=<account-id>
CLOUDFLARE_TEAM_NAME=<team-name>
WORKERS_SUBDOMAIN=<account-subdomain>
```

Do not paste this file or its token into chat. Subsequent automation should source only this file for the bounded command that needs it; never echo, print, dump, or include its variables in diagnostics, logs, or evidence:

```sh
set -a
. /home/ubuntu/tracegarden-credentials/cloudflare.env
set +a
# invoke only the pinned command here; do not run env/printenv or echo a secret
```

The token should be scoped only to the selected account/resources and revoked after the disposable run when appropriate.

Typical automation interfaces are:

```sh
npx wrangler deploy
npx wrangler r2 bucket create <run-labelled-bucket>
npx wrangler r2 bucket lifecycle add <run-labelled-bucket> <rule-name> --expire-days <days>
```

Pin Wrangler before use and verify `--help` against that exact version. Access API calls must use the account ID and the run-labelled application/policy only. For a named Tunnel, `cloudflared tunnel create`, `cloudflared tunnel route dns`, and `cloudflared tunnel run` are available after manual authorization; keep the Tunnel token in a `0600` file only.

## Ticket 25: Cloudflare Access and Preview ingress

### Required inputs

Prepare one of these hostname sources:

- Profile A: the account `workers.dev` subdomain and run-labelled OAuth/Preview Worker names;
- Profile B: the owned Cloudflare DNS zone, named Tunnel, and run-labelled hostnames.

Also provide the disposable Access application identity, team domain, approved credential/configuration path, and explicit cleanup authority. Keep the Access JWT assertion and token material out of evidence.

The Access issuer is normally:

```text
https://<team-name>.cloudflareaccess.com
```

The audience is the Access application's **Application Audience (AUD) Tag**, not its hostname. The repository consumes:

```text
CLOUDFLARE_ACCESS_JWT_ISSUER
CLOUDFLARE_ACCESS_JWT_AUDIENCE
CLOUDFLARE_ACCESS_JWT_PUBLIC_KEY
```

Fetch the current public certificate into a run-scoped `0600` file from `<issuer>/cdn-cgi/access/certs`. Cloudflare rotates signing keys, so refresh this key before a long run and record only capture time/issuer metadata. The application validates the JWT signature, issuer, audience, subject, and expiry; an identity header alone is not accepted.

Preview chart configuration maps these values to `preview.host` and `preview.access.{issuer,audience,bootstrapSubject,publicKey}`. Keep protected values and the GitOps path private even though the public key is not a credential.

### Live proof and cleanup

Use the normal Preview deployment and verify separately:

1. TLS/hostname reaches only the selected disposable Preview route.
2. A valid Access JWT admits the designated identity.
3. Missing, expired, wrong-signature, wrong-issuer, wrong-audience, and spoofed identity-header requests fail.
4. The Preview has no production data, credentials, or volumes.
5. A real SSE stream passes through the selected Worker/Tunnel path.
6. Draft/close cleanup removes the Preview route and makes the hostname unavailable within the documented bound.
7. The direct VM origin without the high-entropy Worker secret returns `403` in Profile A.

Afterward, remove only the run-labelled Worker, Access application/policy, Tunnel route or Worker-to-origin route, disposable DNS record/origin resource, and connector. Preserve the shared account/team and unrelated Caddy routes. Never broaden egress or weaken JWT validation to make a check pass.

Official references: [Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/), [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Tunnel setup](https://developers.cloudflare.com/tunnel/setup/), and [Quick Tunnels limitations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

## Ticket 24: Google OAuth callback

Create a disposable Google Cloud project/client manually. Configure the consent screen and explicit test users for three controlled identities: bootstrap owner, invited Member, and rejected/uninvited identity. Use stable issuer-and-subject identity; email is not the durable key.

The authorized redirect URI must exactly match the deployed HTTPS hostname and path:

```text
https://tracegarden-oauth.<account-subdomain>.workers.dev/api/auth/callback/google
```

for Profile A, or:

```text
https://app.<owned-domain>/api/auth/callback/google
```

for Profile B. Google Console acceptance of a `workers.dev` redirect must be confirmed when creating the client; if Google rejects the shared-platform hostname, use Profile B rather than claiming callback proof in advance. Do not add wildcard, localhost, or Preview redirects to this client.

Store the client secret only in a run-scoped `0600` file, for example:

```text
/home/ubuntu/tracegarden-credentials/google.env
```

```dotenv
GOOGLE_CLIENT_ID=<client-id>
GOOGLE_CLIENT_SECRET=<0600-file-only>
GOOGLE_REDIRECT_URI=https://<selected-oauth-host>/api/auth/callback/google
```

The production chart maps this to `config.googleClientId`, `config.googleRedirectUri`, `config.bootstrapIssuer`, `config.bootstrapSubject`, and Secret `tracegarden-google/GOOGLE_CLIENT_SECRET`. The runtime also requires its existing database, Better Auth, and timeline secrets through their approved Secret paths.

The operator must complete browser consent; automation must not capture passwords, OAuth codes, JWTs, cookies, or full email addresses. Live evidence should cover valid state/callback, returning login, bootstrap owner exactly once, invited admission, absent/revoked Invitation rejection, invalid state, denied callback, insecure/wrong redirect, and repeat-login partitions. Remove only the authorized test Invitations, sessions, and Memberships afterward. Delete the disposable client/project only if that cleanup is authorized.

Official references: [Google OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [OAuth clients](https://support.google.com/cloud/answer/15549257?hl=en), [OIDC claims](https://developers.google.com/identity/openid-connect/openid-connect), and [Google test users](https://support.google.com/cloud/answer/15549945?hl=en).

## Ticket 27: encrypted R2 backup and clean restore

This optional path is intentionally skipped for the current personal deployment; Ticket 27 is `wontfix` until off-site disaster recovery is needed. If that need changes, reopen the ticket and create one run-labelled R2 bucket and one bucket-scoped Object Read & Write token. Keep the access key identifier as metadata only and keep the secret key in a `0600` file. The endpoint is:

```text
https://<account-id>.r2.cloudflarestorage.com
```

Use region `auto`, a unique prefix such as `ticket-27/<run-id>/`, and a lifecycle rule whose positive expiration matches `BACKUP_RETENTION_DAYS`. The repository configuration requires:

```text
BACKUP_ENDPOINT
BACKUP_BUCKET
BACKUP_SCHEDULE
BACKUP_RETENTION_DAYS
BACKUP_DESTINATION_SCOPE=off-vm
BACKUP_CREDENTIALS_SOURCE=kubernetes-secret/<name>
BACKUP_ENCRYPTION_MECHANISM=aes-256-gcm
BACKUP_ENCRYPTION_KEY_FILE=/var/run/tracegarden-backup/encryption-key
AWS_DEFAULT_REGION=auto
```

Use the attested backup image digest from Ticket 26. Keep the R2 credential source and 32-byte encryption key in Kubernetes Secrets/run-scoped `0600` files. Do not enable the CronJob until the endpoint egress is narrowly enforceable. R2 exposes a DNS endpoint, not a bucket-specific static IP range; prefer FQDN/SNI egress. If only CIDRs are available, record time-bounded DNS A/AAAA results and obtain explicit authorization for those exact ranges. Never use all Cloudflare ranges or `0.0.0.0/0`.

Use a new local Mac Docker PostgreSQL container or second authorized VM as the restore target, never the source/production database. Bind it to loopback, use a generated password file, and keep `RESTORE_DATABASE_URL`, `RESTORE_ARTIFACT_PATH`, `RESTORE_ENCRYPTION_KEY_FILE`, and `RESTORE_TARGET_MUST_BE_CLEAN=true` in a `0600` env file. `scripts/restore-rehearsal.mjs` must reject a dirty target, decrypt only to a `0600` temporary file, restore with single-transaction/no-owner/no-privileges options, and verify all migrations, tables, foreign keys, Workspace state, and Timeline state.

Verify R2 only by object metadata (prefix/key, size, headers, lifecycle); never print object bytes, plaintext dumps, passwords, or keys. After evidence is sealed, remove only the run prefix, lifecycle rule or disposable bucket, runtime/admin tokens, restore container/volume/files, and temporary credentials. A bucket must be emptied before deletion.

Official references: [R2 S3 API](https://developers.cloudflare.com/r2/get-started/s3/), [R2 tokens](https://developers.cloudflare.com/r2/api/tokens/), [R2 lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/), [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/), and [R2 architecture](https://developers.cloudflare.com/r2/how-r2-works/).

## Ticket 29: separate kind cluster and target CNI

Ticket 29 is non-blocking and is administratively closed as `wontfix` with production-target proof deferred because no supported production CNI has been named. If reopened or replaced by a successor, first confirm production NetworkPolicy ownership and authorization for the proposed check, then create a new disposable kind context such as `tracegarden-cilium-29` with non-overlapping Pod/Service CIDRs and `disableDefaultCNI: true`. Pin Cilium `1.20.1` for characterization, install it only in that cluster, and delete the cluster after the run. Do not mutate `k8s-cluster-v137` or its Caddy/kind resources.

Before Tracegarden policy/probe mutation, record only metadata:

- kind/Kubernetes and Cilium versions, context, node architecture, and Cilium status;
- Kubernetes API Service ClusterIP/service port;
- EndpointSlice endpoint IP/target port;
- the authorized disposable namespace and run label.

Run web and collector API requests separately with the ordinary configured client. Capture Cilium flow evidence using Hubble or `cilium-dbg monitor --type trace -v`, and state whether policy evaluation is pre- or post-Service-DNAT. Record the policy object/type and narrow TCP API port. Keep API reachability distinct from application readiness and RBAC.

If the unchanged production policy cannot express the observed target-CNI behavior, record the compatibility gap and stop. Do not add `0.0.0.0/0`, disable/bypass a production NetworkPolicy, use a proxy, mutate the CNI, or add a production exception. Remove all disposable workloads and probes by run label and confirm the existing cluster, workloads, policies, and container identities are unchanged.

Official references: [Cilium kind installation](https://docs.cilium.io/en/stable/installation/kind/), [Cilium NetworkPolicy](https://docs.cilium.io/en/stable/network/kubernetes/policy/), [Cilium layer-3 policy](https://docs.cilium.io/en/stable/security/policy/layer3/), [Cilium monitor](https://docs.cilium.io/en/stable/cmdref/cilium-dbg_monitor/), and [kind quick start](https://kind.sigs.k8s.io/docs/user/quick-start/).

## Operator handoff

When ready, provide only the following metadata and secure file paths, never secret contents:

```text
Cloudflare profile: workers.dev or owned-domain+Tunnel
Cloudflare credential file: /home/ubuntu/tracegarden-credentials/cloudflare.env
OAuth hostname: <hostname>
Preview hostname: <hostname>
Cloudflare Access team/issuer and AUD: <metadata only>
Google credential file: /home/ubuntu/tracegarden-credentials/google.env
R2 credential file (optional Ticket 27): /home/ubuntu/tracegarden-credentials/object-storage.env
Backup encryption-key path (optional Ticket 27): /home/ubuntu/tracegarden-credentials/backup-key
Restore target (optional Ticket 27): separate clean PostgreSQL target and cleanup authority
Ticket 29 target CNI/version/context: <metadata when selected>
```

Do not send token values, client secrets, R2 secret keys, database passwords, encryption keys, JWTs, cookies, codes, dumps, full emails, or protected row content. Ticket 24 cannot be honestly resolved until its provider resources, secure delivery path, controlled identities, and cleanup authority are available. Ticket 27 is intentionally deferred for the current personal deployment and should be reopened only when its explicit off-site disaster-recovery triggers and resources are available.
