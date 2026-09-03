# 25: Attest Cloudflare Access and Preview ingress

**What to build:** A disposable Preview hostname from a Cloudflare-controlled source (an owned DNS zone or the account `workers.dev` hostname) admits only valid Cloudflare Access assertions and is removed with its Preview Environment through an authenticated Tunnel or Worker-to-origin ingress.

**Blocked by:** 23: Prove Argo CD reconciliation and Preview Environment cleanup on kind.

**Status:** needs-info

- [ ] A disposable Cloudflare-controlled hostname source (owned DNS zone or account `workers.dev`), Access application, issuer, audience, test identity, authenticated Tunnel or Worker-to-origin path, and cleanup authority are supplied explicitly.
- [ ] DNS/TLS or `workers.dev` routing reaches only the authorized disposable Preview ingress.
- [ ] The Worker-to-origin path requires a high-entropy run-scoped secret; direct origin access without it returns `403`.
- [ ] Valid Access JWT admission succeeds; missing, expired, wrong-signature, wrong-issuer, and wrong-audience assertions fail.
- [ ] Spoofed identity headers without a valid JWT fail.
- [ ] A real SSE stream passes through the selected Tunnel or Worker path.
- [ ] The Preview mounts no production data, credentials, or volumes.
- [ ] Draft/close reconciliation removes the ingress and makes the hostname unavailable within the documented bound.
- [ ] Disposable Worker/Access, DNS or Tunnel route, origin route, and run secret are removed where authorized; unrelated Caddy routes remain unchanged.

## Safe stop rules

Do not enumerate unrelated Cloudflare zones, applications, tunnels, Workers, or secrets. Stop if any resource is shared with production or not explicitly disposable. Never weaken JWT validation, expose a direct origin, use a Quick Tunnel as persistent ingress, or alter production DNS/Access policy. Stop if the origin secret, route ownership, SSE path, or cleanup authority is ambiguous.

## Needed from the operator

Provide the disposable hostname source (owned zone or account `workers.dev`), Access application details, authenticated Tunnel or Worker-to-origin path, approved credential/configuration path, and explicit route/origin cleanup authority.
