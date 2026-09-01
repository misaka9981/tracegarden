# 19: Provide a disabled encrypted backup and restore path

**What to build:** Operators receive an explicit, disabled-by-default path for encrypted PostgreSQL backups to off-VM object storage and a documented restore rehearsal. The deployment cannot imply disaster recovery until storage, encryption, retention, credentials, and restoration are deliberately configured and proven.

**Blocked by:** 13: Enforce Observation retention; 16: Render the production Kubernetes deployment safely.

**Status:** resolved

- [x] The deployment includes a backup CronJob template that is disabled by default.
- [x] Enabling backup requires explicit object-storage endpoint, bucket, encryption mechanism, credential source, schedule, and retention configuration.
- [x] Backup and restore processes keep secret values out of Git, ordinary ConfigMaps, command output, and application telemetry.
- [x] A backup artifact is encrypted before leaving the database environment and is intended for storage off the production VM.
- [x] The restore procedure targets a clean PostgreSQL instance and defines integrity checks that demonstrate application-readable state.
- [x] Offline rendering and credential-free process tests pass without contacting Cloudflare R2 or another external store.
- [x] Copying a dump to the same VM is explicitly not accepted as disaster recovery evidence.
- [x] Live backup upload and restore rehearsal remain marked unverified until explicitly authorized infrastructure and credentials are provided.

## Answer

Implemented the disabled-by-default encrypted PostgreSQL backup CronJob, fail-closed configuration gates, off-VM destination policy, and clean-database restore rehearsal. All acceptance boxes are checked.

Offline evidence:

- `pnpm test:backup` passed: AES-256-GCM round-trip and tamper checks, off-VM/credential/endpoint gates, clean/restored-database checks, and an uploader boundary receiving encrypted bytes only.
- `pnpm test:chart` passed: offline Helm rendering plus strict kubeconform validation across default, upgrade, failure, enabled-backup, and unsafe-input cases. The default CronJob is suspended and omits `BACKUP_ENDPOINT`.
- `pnpm chart:render` passed with 21 rendered resources, including the suspended backup CronJob and no endpoint secret reference.
- `docs/backup-restore.md` and `scripts/restore-rehearsal.mjs` document and enforce a clean PostgreSQL target, encrypted restore, migration/table/foreign-key/application-readable checks, and rejection of same-VM copies as disaster-recovery evidence.

Live backup upload and live restore rehearsal remain explicitly unverified pending authorized object storage, restore infrastructure, and credentials.
