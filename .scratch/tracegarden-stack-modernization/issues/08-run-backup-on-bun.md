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

Implemented the backup-only Bun runtime migration and verified the encrypted backup and restore contract locally and on the authorized ARM64 VM. The exact runtime-bearing integration commit tested on the VM was `02f4e88dd59ebc000f643d873ba8beb87973f115` (tree `83fa87f78aa781bfa4fbb58c32626776f43d722e`), transferred from a clean archive before acceptance. Ticket 08 history is observable as initial Ticket 08 implementation commit `d924b61e51dc9a6f8726efb424c35ef6122fb6c2`, timeout/cancellation follow-up `740622d9c0fb3f37acaf477fa44f557ba9b44ff8`, and integrated main commit `ca86f99b1f99c3e228799c51673eec4d6627db2b`; the old Node migration wording was historical pre-migration text. The backup remains disabled by default, uses Secret references when enabled, and retains PostgreSQL 18.3 `pg_dump`/`pg_restore`, native SigV4, AES-256-GCM, validation, cleanup, and redaction boundaries. Final ARM64 `CI=true pnpm acceptance` exited 0 after bounded run-owned tooling setup; all run resources were removed and no object storage, Kubernetes/kind, Caddy, credentials, or unrelated Docker resources were contacted or mutated. The full evidence report is `evidence/08-bun-backup/report.md`. Live object-storage upload, off-VM restore, and production enablement remain unverified. The post-validation amend changes only this issue and the evidence report; `git diff --name-status 02f4e88dd59ebc000f643d873ba8beb87973f115..HEAD` is the recorded tree-difference check.

## Safe stop rules

Do not enable backup, contact object storage, print protected values, replace PostgreSQL tooling, or combine this with a restore-format change.
