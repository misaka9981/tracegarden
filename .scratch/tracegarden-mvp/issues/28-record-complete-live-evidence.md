# 28: Record the complete live acceptance evidence matrix

**What to build:** Maintainers can distinguish locally proven behavior, VM/kind live evidence, authorized third-party evidence, and intentionally unverified production boundaries from one secret-free record.

**Blocked by:** 21: Prove the ARM64 VM runtime baseline; 22: Prove live Kubernetes compatibility and RBAC on the authorized kind Cluster; 23: Prove Argo CD reconciliation and Preview Environment cleanup on kind; 24: Attest real Google OAuth callbacks; 25: Attest Cloudflare Access and Preview ingress; 26: Attest immutable GitHub publication and pull-based promotion; 27: Attest off-VM backup upload and restore.

**Status:** claimed

- [ ] Each predecessor links secret-free evidence with commit, authorized resource identifiers, timestamps, checks, cleanup, and residual risks.
- [ ] The matrix distinguishes local deterministic evidence from live provider evidence and does not infer one provider from another.
- [ ] No credential, token, cookie, authorization code, private key, full identity value, plaintext dump, or protected row content appears.
- [ ] Every resource created for validation is either confirmed removed or explicitly retained with operator authorization.
- [ ] Any production promotion not separately authorized remains unverified.
- [ ] A fresh Sol medium review finds no unsupported live claim.

## Safe stop rules

Do not resolve while any predecessor remains open or any evidence/cleanup state is ambiguous. Redact or discard unsafe evidence rather than committing it.

## Answer

Maximum honest progress is recorded in [evidence/live-acceptance-matrix.md](../../../evidence/live-acceptance-matrix.md). The matrix links the secret-free evidence for Tickets 21, 22, 23, and 26, separates local, ARM64 VM/kind, GitHub/GHCR/GitOps, and disposable Argo evidence, and records the exact residual non-claims. Tickets 24 (Google OAuth), 25 (Cloudflare Access), and 27 (off-VM backup/restore) remain `needs-info` with no retained live evidence; Ticket 21 remains `claimed` pending fresh review; and non-blocking Ticket 29 is administratively closed as `wontfix` with its target-CNI proof deferred. Ticket 28 therefore remains claimed and is not resolved.

Next observable completion criteria are: resolve the open predecessor tickets with authorized, secret-free evidence and scoped cleanup; verify every predecessor's source commit, resource identifiers, bounded checks, and residual risks in the matrix; confirm that no production promotion is inferred from disposable validation; and pass a fresh Sol medium review without unsupported claims.
