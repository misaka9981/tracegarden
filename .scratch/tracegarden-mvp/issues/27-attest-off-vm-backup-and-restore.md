# 27: Attest off-VM backup upload and restore

**What to build:** The attested backup image uploads encrypted data to an authorized off-VM object prefix and restores it into a separate clean PostgreSQL target.

**Blocked by:** 22: Prove live Kubernetes compatibility and RBAC on the authorized kind Cluster; 26: Attest immutable GitHub publication and pull-based promotion.

**Status:** needs-info

- [ ] An authorized object-storage endpoint, bucket, unique test prefix, endpoint CIDRs, least-privilege credential path, encryption-key path, retention rule, separate restore target, and cleanup authority are supplied explicitly.
- [ ] The enabled CronJob uses the attested backup digest and complete Secret-referenced configuration.
- [ ] One backup uploads only encrypted bytes under the authorized prefix; no plaintext dump leaves the database boundary.
- [ ] The object lifecycle matches declared retention.
- [ ] The artifact restores into a new clean PostgreSQL database on a separate authorized host or isolated VM.
- [ ] Restore rehearsal passes all migration, table, foreign-key, Workspace, and Timeline checks; a dirty-target restore is rejected.
- [ ] Only the unique test prefix and disposable restore target are removed where authorized.

## Safe stop rules

Do not enumerate buckets, prefixes, lifecycle rules, Kubernetes Secrets, or secret stores beyond supplied identifiers. Never restore over production or print credentials, keys, URLs, dumps, or row contents.

## Needed from the operator

Provide the disposable object-storage resources and credentials through an approved non-transcript path, plus a separate clean restore target and explicit object/target cleanup authority.
