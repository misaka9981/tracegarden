# Ticket 25 — Cloudflare Preview Access

**Status: needs-info**

This is a bounded provider-readiness check. No Worker, Access application, policy, route, DNS record, Caddy configuration, Kubernetes resource, or production resource was created or changed.

## Safe credential-path check

The authorized VM file `/home/ubuntu/tracegarden-credentials/cloudflare.env` exists with owner `ubuntu` and mode `0600`. The following variable names are present; their values were never printed, logged, or copied into this report:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_TEAM_NAME`
- `WORKERS_SUBDOMAIN`

The token verification endpoint returned `active`, and the account metadata request succeeded. The workers subdomain API returned a configured subdomain but did not establish an enabled `workers.dev` deployment. The account Access-organization endpoint returned `403` for the supplied token, so organization readiness was not inferred. The account Access-application list was empty; no existing application was enumerated or changed.

## Result

Ticket 25 cannot yet be resolved because the provider bootstrap and interactive identity boundary are not complete for an honest live proof. The following manual actions are still required:

1. Confirm/enable the account `workers.dev` subdomain and complete Cloudflare Zero Trust organization onboarding, if not already complete.
2. Create the disposable Preview Access application and an allow policy for one controlled test identity. Record only the team issuer and application AUD; do not provide JWTs or cookies.
3. Complete one normal browser login for that identity, or provide an approved non-transcript way for the bounded run to obtain the valid assertion. A valid identity cannot be fabricated from account metadata.
4. Confirm cleanup authority for the disposable Worker, Access application/policy, origin route, and run secret.

Once those actions are complete, automation can deploy the two run-labelled `workers.dev` Workers, establish the authenticated Worker-to-origin route, deploy the disposable Preview workload, test Access denial/admission and SSE, and clean all run-owned resources. The direct origin must remain `403` without the run secret; no broad egress, Quick Tunnel, proxy bypass, or production mutation is permitted.

## Commands and bounded results

- Authorized SSH with `BatchMode=yes`, `IdentitiesOnly=yes`, and `ConnectTimeout=10`: passed.
- VM credential file owner/mode/name-only inspection: passed.
- Cloudflare account API metadata check with a 10-second request limit: passed.
- Cloudflare token verification with a 10-second request limit: passed (`active`).
- Workers subdomain metadata check with a 10-second request limit: passed; enabled deployment not established.
- Access organization metadata check with a 10-second request limit: not verified (`403`); no readiness claim made.
- Access application list check with a 10-second request limit: passed; no application was created or changed.

## Residual boundary

No valid Access assertion, Preview hostname routing, Worker-to-origin secret check, direct-origin `403`, SSE pass-through, Preview workload isolation, or cleanup lifecycle was exercised. Ticket remains `needs-info` until the provider and interactive identity prerequisites above are supplied.
