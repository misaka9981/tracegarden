# Backup and restore rehearsal

Tracegarden ships an encrypted PostgreSQL backup path, but it is disabled by default. The Helm CronJob is suspended until all of these values are deliberately configured:

- an HTTPS object-storage endpoint, its authorized egress CIDR range, and bucket;
- `aes-256-gcm` as the encryption mechanism and a Kubernetes Secret containing a 32-byte encryption key;
- a Kubernetes Secret containing the object-storage access and secret keys;
- a CronJob schedule; and
- a positive retention period, implemented by the configured object-storage lifecycle policy.

The backup process runs `pg_dump --format=custom`, encrypts the dump locally with AES-256-GCM, and only then invokes the S3-compatible uploader. The database URL, encryption key, and object-storage credentials come from Secret references or a mounted Secret file. They are never put in Git, a ConfigMap, command output, or application telemetry. The artifact is uploaded to the configured endpoint and bucket, which must be off the production VM. A local or same-VM copy is not disaster recovery evidence.

## Configuration gate

Set the following values together; leaving any value empty makes enabling fail closed:

```yaml
backup:
  enabled: true
  endpoint: https://<authorized-object-storage-endpoint>
  endpointCIDRs:
    - <authorized-object-storage-CIDR>
  bucket: <authorized-bucket>
  schedule: "0 2 * * *"
  retentionDays: 30
  offVm: true
  encryption:
    mechanism: aes-256-gcm
    keySecret:
      existingSecret: <backup-encryption-secret>
      key: BACKUP_ENCRYPTION_KEY
  credentials:
    existingSecret: <backup-storage-secret>
    accessKeyIdKey: AWS_ACCESS_KEY_ID
    secretAccessKeyKey: AWS_SECRET_ACCESS_KEY
```

`<...>` values are placeholders, not credentials. The encryption key Secret and object-storage Secret must be created through the authorized secret-management path; neither Secret value belongs in this repository. The retention value is a declaration that must match an object-storage lifecycle/retention rule.

## Restore rehearsal

A restore is only a rehearsal when it uses a newly created, clean PostgreSQL database on a different restore host or isolated restore VM. Do not restore over production and do not use a dump copied to the production VM as evidence.

1. Create an empty PostgreSQL database on the authorized restore host. Do not reuse a database containing application tables.
2. Provide the encrypted artifact path and the encryption Secret file through the environment. Keep `RESTORE_DATABASE_URL` in the local process environment or an authorized secret manager; do not put it in a command transcript.
3. Run:

   ```sh
   RESTORE_ARTIFACT_PATH=/secure/restore/tracegarden.dump.enc \
   RESTORE_DATABASE_URL='postgresql://<restore-user>@<clean-restore-host>:5432/tracegarden_restore' \
   RESTORE_ENCRYPTION_KEY_FILE=/secure/restore/BACKUP_ENCRYPTION_KEY \
   RESTORE_TARGET_MUST_BE_CLEAN=true \
   node scripts/restore-rehearsal.mjs
   ```

   The script refuses a target that already contains application tables, decrypts the artifact, runs `pg_restore --exit-on-error --single-transaction`, and removes its temporary plaintext dump.
4. Record the rehearsal result without recording credentials or database contents. The checks must show:
   - every current migration is recorded as applied;
   - the full application table set exists, including authentication, membership, invitations, audits, observations, timeline, checkpoints, experiments, correlation, and retention tables;
   - every application foreign-key constraint is present and validated; and
   - a Workspace/Timeline projection is application-readable.

The repository's offline backup test verifies authenticated encryption and that an uploader receives encrypted bytes only. It uses no database, cloud endpoint, R2 account, Kubernetes context, or credentials. Live upload and restore rehearsal remain **unverified** until authorized storage, restore infrastructure, and credentials are supplied.
