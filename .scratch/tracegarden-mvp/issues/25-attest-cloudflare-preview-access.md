# 25: Attest Cloudflare Access and Preview ingress

**What to build:** A disposable Preview hostname admits only valid Cloudflare Access assertions and is removed with its Preview Environment.

**Blocked by:** 23: Prove Argo CD reconciliation and Preview Environment cleanup on kind.

**Status:** needs-info

- [ ] A disposable hostname, DNS zone, Access application, issuer, audience, test identity, tunnel/ingress path, and cleanup authority are supplied explicitly.
- [ ] DNS and TLS route only the authorized hostname to the disposable Preview ingress.
- [ ] Valid Access JWT admission succeeds; missing, expired, wrong-signature, wrong-issuer, and wrong-audience assertions fail.
- [ ] Spoofed identity headers without a valid JWT fail.
- [ ] The Preview mounts no production data, credentials, or volumes.
- [ ] Draft/close reconciliation removes the ingress and makes the hostname unavailable within the documented bound.
- [ ] Disposable DNS, Access, and tunnel resources are removed where authorized.

## Safe stop rules

Do not enumerate unrelated Cloudflare zones, applications, tunnels, or secrets. Stop if any resource is shared with production or not explicitly disposable. Never weaken JWT validation or alter production DNS/Access policy.

## Needed from the operator

Provide the disposable hostname and Access application details plus an approved credential/configuration path and explicit DNS/tunnel cleanup authority.
