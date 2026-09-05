# 24: Attest real Google OAuth callbacks

**What to build:** An explicitly authorized Google OAuth test client completes Tracegarden callbacks for the designated Bootstrap Owner and returning Member through an exact stable HTTPS callback, hosted on an owned domain or a Cloudflare `workers.dev` hostname, without exposing identity material. Live invited-Member and rejected-identity Google-provider flows are explicitly out of scope for this personal single-owner deployment; their application authorization semantics remain covered by deterministic tests.

**Blocked by:** 22: Prove live Kubernetes compatibility and RBAC on the authorized kind Cluster.

**Status:** claimed

- [ ] An authorized Google OAuth test client, exact HTTPS redirect URI (including an accepted stable `workers.dev` callback where used), client credential delivery path, and the designated Bootstrap Owner identity are supplied explicitly. Live invited/rejected provider identities are out of scope and are not prerequisites.
- [ ] Valid OAuth state and callback create or reuse the durable issuer-and-subject identity; email is not the durable key.
- [ ] The designated Bootstrap Owner becomes owner exactly once, and a returning login reuses the same identity and membership. Live invited-Member and rejected-identity Google-provider flows are deferred; application invitation authorization remains covered by deterministic tests.
- [ ] Invalid state, denied callback, insecure redirect, and repeated-login partitions are exercised without recording tokens, codes, cookies, secrets, or full email addresses.
- [ ] Test sessions and Memberships are removed where authorized; no out-of-scope invited/rejected provider identities are created or retained.

## Safe stop rules

Do not discover Google projects or inspect secret stores. Stop if the client, exact redirect URI, Bootstrap Owner selector, OAuth scopes, or cleanup authority are ambiguous. Live invited/rejected provider identities are not required for this scope. If Google Console does not accept the selected `workers.dev` redirect URI, use an authorized owned-domain HTTPS callback instead. Never modify an existing production OAuth client.

## Needed from the operator

Provide the authorized OAuth client identifier/secret through an approved non-transcript channel, the exact authorized HTTPS redirect URI, the Bootstrap Owner selector, and cleanup authority. Invited-Member and rejected-identity Google-provider accounts are explicitly out of scope for this personal deployment. The ticket remains claimed until the owner-only provider behavior and cleanup are evidenced.
