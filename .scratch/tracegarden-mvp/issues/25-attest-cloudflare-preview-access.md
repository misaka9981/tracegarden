# 25: Attest Cloudflare Access and Preview ingress

**What to build:** A disposable Preview hostname from a Cloudflare-controlled source (an owned DNS zone or the account `workers.dev` hostname) admits only valid Cloudflare Access assertions and is removed with its Preview Environment through an authenticated Tunnel or Worker-to-origin ingress.

**Blocked by:** 23: Prove Argo CD reconciliation and Preview Environment cleanup on kind.

**Status:** resolved

- [x] A disposable Cloudflare-controlled hostname source (owned DNS zone or account `workers.dev`), Access application, issuer, audience, test identity, authenticated Tunnel or Worker-to-origin path, and cleanup authority are supplied explicitly.
- [x] DNS/TLS or `workers.dev` routing reaches only the authorized disposable Preview ingress.
- [x] The Worker-to-origin path requires a high-entropy run-scoped secret; direct origin access without it returns `403`.
- [x] Valid Access JWT admission succeeds; missing, expired, wrong-signature, wrong-issuer, and wrong-audience assertions fail.
- [x] Spoofed identity headers without a valid JWT fail.
- [x] A real SSE stream passes through the selected Worker path, including a committed Timeline event and reconnect.
- [x] The Preview mounts no production data, credentials, or volumes.
- [x] Draft/close reconciliation removes the ingress and makes the hostname unavailable within the documented bound.
- [x] Disposable Worker/Access, DNS or Tunnel route, origin route, and run secret are removed where authorized; unrelated Caddy routes remain unchanged.

## Safe stop rules

Do not enumerate unrelated Cloudflare zones, applications, tunnels, Workers, or secrets. Stop if any resource is shared with production or not explicitly disposable. Never weaken JWT validation, expose a direct origin, use a Quick Tunnel as persistent ingress, or alter production DNS/Access policy. Stop if the origin secret, route ownership, SSE path, or cleanup authority is ambiguous.

## Answer

Resolved using the free personal-use `workers.dev` profile documented in [the evidence report](../../../evidence/25-cloudflare-preview-access/report.md) and its [sanitized cleanup transcript](../../../evidence/25-cloudflare-preview-access/cleanup-transcript.txt). The final bounded run proved the disposable Access boundary, strict JWT signature/issuer/audience/expiry validation, rejection of untrusted identity headers, authenticated Worker-to-origin application access, direct-origin secret denial, isolated Preview resources, and real SSE ready/Timeline/reconnect behavior. The run-owned notification trigger produced a committed Timeline event without retaining row or identity values. Cleanup removed the run Worker, Access resources, origin route/secret, namespace, and temporary files; post-cleanup hostnames were unavailable and the existing Caddy/kind container IDs and running state were unchanged.

This resolution is limited to the disposable free `workers.dev` provider profile. It does not claim an owned production DNS zone, production Tunnel, Google OAuth, off-VM object-storage backup/restore, target-CNI compatibility, production deployment, or production promotion.
