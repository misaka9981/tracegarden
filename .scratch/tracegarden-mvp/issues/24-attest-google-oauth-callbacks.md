# 24: Attest real Google OAuth callbacks

**What to build:** An explicitly authorized Google OAuth test client completes Tracegarden callbacks for invited, rejected, and returning Members through an exact stable HTTPS callback, hosted on an owned domain or a Cloudflare `workers.dev` hostname, without exposing identity material.

**Blocked by:** 22: Prove live Kubernetes compatibility and RBAC on the authorized kind Cluster.

**Status:** needs-info

- [ ] An authorized Google OAuth test client, exact HTTPS redirect URI (including an accepted stable `workers.dev` callback where used), client credential delivery path, bootstrap identity, invited identity, and rejected identity are supplied explicitly.
- [ ] Valid OAuth state and callback create or reuse the durable issuer-and-subject identity; email is not the durable key.
- [ ] The designated bootstrap identity becomes owner exactly once; invited admission succeeds and absent/revoked Invitation admission fails.
- [ ] Invalid state, denied callback, insecure redirect, and repeated-login partitions are exercised without recording tokens, codes, cookies, secrets, or full email addresses.
- [ ] Test Invitations, sessions, and Memberships are removed where authorized.

## Safe stop rules

Do not discover Google projects or inspect secret stores. Stop if redirect URI, OAuth scopes, identities, or cleanup authority are ambiguous. If Google Console does not accept the selected `workers.dev` redirect URI, use an authorized owned-domain HTTPS callback instead. Never modify an existing production OAuth client.

## Needed from the operator

Provide the disposable OAuth client identifier/secret through an approved non-transcript channel, the exact authorized HTTPS redirect URI, and designated test identities. The ticket remains `needs-info` until Google Console accepts the exact URI and the disposable client exists.
