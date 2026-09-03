# 08: Run backup tooling on Bun

**What to build:** Make the disabled-by-default encrypted backup process run on the pinned Bun runtime without changing its security or restore contract.

**Blocked by:** 04: Prove Bun runtime compatibility.

**Status:** resolved

- [x] URL/credential validation, `pg_dump` process handling, AES-256-GCM encryption-before-upload, native SigV4, timeout/error redaction, and temporary-file cleanup retain parity.
- [x] The backup image keeps the pinned PostgreSQL client binaries and is immutable, non-root, read-only, capability-dropped, and ARM64-compatible.
- [x] Default manifests remain disabled/suspended and contain no endpoint or credential value.
- [x] Backup, restore rehearsal, container binary smoke, chart, and ARM64 VM checks pass without contacting object storage.
- [x] Live off-VM backup/restore remains explicitly unverified until its separate authorized ticket runs.

## Answer

Implemented the backup-only Bun runtime migration and verified the encrypted backup and restore contract locally and on the authorized ARM64 VM. The backup remains disabled by default, uses Secret references when enabled, and retains PostgreSQL 18.3 `pg_dump`/`pg_restore`, native SigV4, AES-256-GCM, validation, cleanup, and redaction boundaries. The full evidence report is `evidence/08-bun-backup/report.md`. Live object-storage upload, off-VM restore, and production enablement remain unverified.

## Safe stop rules

Do not enable backup, contact object storage, print protected values, replace PostgreSQL tooling, or combine this with a restore-format change.
