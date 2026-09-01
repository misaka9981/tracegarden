# 19: Provide a disabled encrypted backup and restore path

**What to build:** Operators receive an explicit, disabled-by-default path for encrypted PostgreSQL backups to off-VM object storage and a documented restore rehearsal. The deployment cannot imply disaster recovery until storage, encryption, retention, credentials, and restoration are deliberately configured and proven.

**Blocked by:** 13: Enforce Observation retention; 16: Render the production Kubernetes deployment safely.

**Status:** ready-for-agent

- [ ] The deployment includes a backup CronJob template that is disabled by default.
- [ ] Enabling backup requires explicit object-storage endpoint, bucket, encryption mechanism, credential source, schedule, and retention configuration.
- [ ] Backup and restore processes keep secret values out of Git, ordinary ConfigMaps, command output, and application telemetry.
- [ ] A backup artifact is encrypted before leaving the database environment and is intended for storage off the production VM.
- [ ] The restore procedure targets a clean PostgreSQL instance and defines integrity checks that demonstrate application-readable state.
- [ ] Offline rendering and credential-free process tests pass without contacting Cloudflare R2 or another external store.
- [ ] Copying a dump to the same VM is explicitly not accepted as disaster recovery evidence.
- [ ] Live backup upload and restore rehearsal remain marked unverified until explicitly authorized infrastructure and credentials are provided.
