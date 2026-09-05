# Ticket 21 ARM64 VM runtime evidence

Status: **resolved**

## Current run and source boundary

- Run: `tracegarden-validation-21-20260905T002916Z-31881`.
- The tested source was the clean tracked archive of the exact current `main` commit `e78d7365346315accccce4bc240ca3e2c7241b3d`, tree `646b479ba93709bd3747289f088ad4d29eb36234`.
- The archive contained 299 tracked archive entries. Its SHA-256 was `2de58fd851b53afe71f83b7013208c6c80675cf2cef325be66aa53ae714aec93`; the remote archive and local path manifest matched exactly.
- No Git metadata, Git credentials, local secrets, build caches, application data, or Kubernetes context was transferred. The run used only the archive and run-scoped validation material.
- A sanitized command/result transcript is retained at [`vm-transcript.txt`](vm-transcript.txt).

## Historical versus current evidence

The earlier run `tracegarden-validation-21-20260902T074817Z-30845` against implementation commit `3240952e49dca28474584d8e8158223705bcb791` remains historical evidence. Its results are not rewritten as current-runtime proof. This report's claims below are exclusively for the VM-tested runtime source archive `e78d736` and the bounded run above.

## Post-run metadata equivalence bridge

The first post-run evidence-only commit is `263bd538f8a2335827d0c51110070f36cc8b7c30`, tree `b05fccd78a769d568545297b6e90dca5898185ca`, with tested runtime source parent `e78d7365346315accccce4bc240ca3e2c7241b3d`, tree `646b479ba93709bd3747289f088ad4d29eb36234`. The deterministic command

```text
git diff-tree --no-commit-id --name-status -r e78d7365346315accccce4bc240ca3e2c7241b3d 263bd538f8a2335827d0c51110070f36cc8b7c30
```

reports exactly these paths and statuses:

```text
M .scratch/tracegarden-mvp/issues/21-prove-arm64-vm-runtime.md
M evidence/21-vm-runtime/report.md
A evidence/21-vm-runtime/vm-transcript.txt
M evidence/live-acceptance-matrix.md
```

The post-run evidence commits collectively alter only this metadata allow-list; no runtime-bearing path changed. Reviewers can verify the final checkout with the same `git diff-tree` command ending at `HEAD`; the VM-tested runtime source remains `e78d736`, and this metadata bridge does not require another VM run.

## VM baseline and validation toolchain

- Authorized VM: Ubuntu 24.04, Linux `6.17.0-1020-oracle`, `aarch64`; 4 CPUs; 23,975 MiB memory; 151,263,856 KiB on `/tmp` with 44,521,088 KiB available at post-run inspection; Docker `29.1.3` server `linux/arm64`.
- Host metadata: Git `2.43.0`, Corepack `0.34.6`, and Helm `v4.1.0+g4553a0a` remained unchanged. The host's system Node was `v22.23.2` and was not replaced. The run used a user-owned pinned Node `v26.8.1` binary for the pnpm/TypeScript/Node validation toolchain and pnpm `11.9.0`.
- Production runtime validation used Bun `1.4.0`; production images use the immutable ARM64 distroless reference `docker.io/oven/bun:1.4.0-distroless@sha256:76caa97ddc0e01333d98c6ab5499539dad4bbceae6237eac83e7853d3826b981`.
- PostgreSQL used `postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7`.
- Native ARM64 kubeconform `v0.6.7` validated strict checked-in schemas under `.ci/kubeconform-schemas/v1.31.0-standalone-strict`; 14 canonical schema files were provisioned from the checked-in checksum-protected archive. Helm `v3.17.3` was run from the pinned ARM64 public helper image.
- The separately rendered current manifests contained 20 production resources and 17 Preview resources. Acceptance's chart and Preview stages passed strict schema validation.

## Acceptance

The bounded command was:

```text
CI=true timeout --foreground 1700s pnpm acceptance
```

It exited `0` and reported `Tracegarden local acceptance workflow passed; no external integrations were contacted.` All 20 sequential stages passed:

1. format check
2. lint
3. strict typecheck
4. production build
5. Bun compiled-ESM compatibility gate
6. Bun migration fresh/upgrade/lock/rollback/retry smoke
7. offline acceptance image preflight policy
8. clean-cache frozen dependency fail-closed policy
9. clean Docker-cache offline container build
10. unit, authorization, telemetry, and domain failure suites
11. deterministic collector failure and recovery suites (Bun)
12. real PostgreSQL integration, auth, retention, log-bound, and live timeline suites
13. existing bilingual browser smoke suite
14. focused browser core-loop scenario
15. offline encrypted backup and restore validation (Bun)
16. provision checked-in Kubernetes schemas
17. offline production deployment and backup manifest validation
18. offline Preview and promotion declaration validation
19. delivery policy validation
20. production web and collector non-root image smoke

Notable bounded results included:

- Bun compiled-ESM, PostgreSQL integration, migration rollback/retry, collector resilience, browser/core-loop, and backup encryption/SigV4/timeout checks passed.
- Four clean-cache ARM64 builds used `--no-cache --network none --pull=false`; the web, collector, migration, and backup images passed their configured Bun, ARM64, non-root/read-only, no-Node, migration-gate, invalid-URL/schema-failure, and `pg_dump`/`pg_restore` checks.
- The current acceptance run used the exact pinned Bun and PostgreSQL references with pull-never smoke behavior. No Kubernetes API, cloud provider, or external integration was contacted.

## Current run image records

The four run-created clean-cache image IDs were recorded before their exact tags were removed:

| service | run-built ARM64 image ID |
| --- | --- |
| web | `sha256:e9c1eae372bc26354ed7fba8e9224edc38a1f002dd93f1825c501006010f0733` |
| collector | `sha256:46f377573ceb5e93552145c6a2816fd074c347c5ca19e738c1b7a9fe5fcf68ed` |
| migrate | `sha256:8e32d3bc7579a57f9e960399e16972469b0f3609f45b58fad5e746dab215a7d1` |
| backup | `sha256:6bc349ae47f001dbd26559f4c8e4b0c4419f71f177dd4df9ed5875b1f242cb86` |

These IDs are run records only; their exact temporary tags were removed during cleanup.

## Cleanup and preservation

- The run archive, source tree, generated `dist`, run-local dependency context, native tools, schema output, Helm helper image, logs, and all other run files were removed after evidence capture.
- Run-created image tags, containers, networks, and volumes were removed by exact run/project names. No global Docker prune was used. No acceptance process remained.
- The pinned Bun, PostgreSQL, and Node base images remained available; the Helm image pulled solely for this run was removed.
- Existing resources remained unchanged and running:

| Resource | Before ID | After ID | Running |
| --- | --- | --- | --- |
| `railgun-caddy` | `26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75` | `26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75` | `true` |
| `k8s-cluster-v137-control-plane` | `d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc` | `d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc` | `true` |
| `k8s-cluster-v137-worker` | `ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e` | `ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e` | `true` |

Ports `22` and `443` remained bound to the same listeners. No existing Caddy/kind service, Kubernetes resource, or unrelated file was changed.

## Remaining boundaries

This validates the current local/ARM64 VM runtime and production container lifecycle only. Google OAuth, Cloudflare, GitHub/GHCR, R2/object-storage, off-VM restore, target production CNI NetworkPolicy behavior, Argo production reconciliation, and production promotion remain intentionally unverified. No credentials, tokens, cookies, authorization codes, private keys, database passwords, protected values, or application data were inspected or retained.
