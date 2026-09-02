# 24: Attest real Google OAuth callbacks

**What to build:** An explicitly authorized Google OAuth test client completes Tracegarden callbacks for invited, rejected, and returning Members without exposing identity material.

**Blocked by:** 22: Prove live Kubernetes compatibility and RBAC on the authorized kind Cluster.

**Status:** needs-info

- [ ] An authorized Google OAuth test client, exact HTTPS redirect URI, client credential delivery path, bootstrap identity, invited identity, and rejected identity are supplied explicitly.
- [ ] Valid OAuth state and callback create or reuse the durable issuer-and-subject identity; email is not the durable key.
- [ ] The designated bootstrap identity becomes owner exactly once; invited admission succeeds and absent/revoked Invitation admission fails.
- [ ] Invalid state, denied callback, insecure redirect, and repeated-login partitions are exercised without recording tokens, codes, cookies, secrets, or full email addresses.
- [ ] Test Invitations, sessions, and Memberships are removed where authorized.

## Safe stop rules

Do not discover Google projects or inspect secret stores. Stop if redirect URI, OAuth scopes, identities, or cleanup authority are ambiguous. Never modify an existing production OAuth client.

## Needed from the operator

Provide the disposable OAuth client identifier/secret through an approved non-transcript channel, the exact authorized HTTPS redirect URI, and designated test identities.
