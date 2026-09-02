# 08: Run backup tooling on Bun

**What to build:** Make the disabled-by-default encrypted backup process run on the pinned Bun runtime without changing its security or restore contract.

**Blocked by:** 04: Prove Bun runtime compatibility.

**Status:** ready-for-agent

- [ ] URL/credential validation, `pg_dump` process handling, AES-256-GCM encryption-before-upload, native SigV4, timeout/error redaction, and temporary-file cleanup retain parity.
- [ ] The backup image keeps the pinned PostgreSQL client binaries and is immutable, non-root, read-only, capability-dropped, and ARM64-compatible.
- [ ] Default manifests remain disabled/suspended and contain no endpoint or credential value.
- [ ] Backup, restore rehearsal, container binary smoke, chart, and ARM64 VM checks pass without contacting object storage.
- [ ] Live off-VM backup/restore remains explicitly unverified until its separate authorized ticket runs.

## Safe stop rules

Do not enable backup, contact object storage, print protected values, replace PostgreSQL tooling, or combine this with a restore-format change.
