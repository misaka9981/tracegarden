# Ticket 09 delivery evidence

**Status:** resolved

## Tested source and scope

The runtime acceptance baseline was the clean `e8da1e1402c30bc3e5e71f1c81cfbbf689d8d8aa` checkout plus the delivery patch transferred for this ticket. The source archive SHA-256 was `9e69dbbb2e1a45d633a25ff027c63b5bf515eb11798578f247f0728b8d89e057`; the binary patch SHA-256 was `a240fad670f51a0aae6a1cedab6ae06bb14ec1b1a7f3b01d0301eaa46725fd44`. The patch changes only delivery workflow, chart contracts, artifact schemas, policy/tests, and documentation; it does not change application process behavior.

The four production processes use the shared immutable ARM64 Bun `1.3.14` reference:
`docker.io/oven/bun:1.3.14-slim@sha256:6068a9d40e9fc5c4519891edb63dfc5935c393fe2228eb9a5b7f472b444b5ee2`.
The obsolete Node production-image prerequisite was removed. Node remains for pnpm, TypeScript, Playwright, and validation; the separately deployed preview lifecycle controller remains Node by design.

## Acceptance

On the authorized ARM64 VM (`aarch64`, Docker `arm64`), run `tracegarden-ticket09-20260903T074400Z-25688`, the runtime baseline plus the initial delivery patch ran `CI=true pnpm acceptance` with bounded execution and exited `0`. It passed format, lint, strict typecheck, build, Bun compatibility, Bun migration, preflight, clean-cache offline four-image builds, unit/domain, Bun collector resilience, PostgreSQL, browser/core-loop, Bun backup, schema/chart, preview/promotion, delivery policy, and ARM64 production image smoke. The acceptance output SHA-256 was `b83c3aa784b58b1d997945dfdacc52f084837f7c8d987f5453cc9d6d669ef7aa`. The final preview-gate and no-sentinel edits were then checked locally with the commands listed below; no publication or external rerun was performed.

The local host also passed frozen install, format, lint, typecheck, build, `test:bun`, unit tests, PostgreSQL, browser, backup, chart, preview, delivery policy, and delivery validation. Local container and full-acceptance attempts failed closed because the exact pinned Bun image was not present; neither attempt pulled an image. The VM run used only existing run-owned tool/image prerequisites and removed its run directory; no run-owned containers, networks, or volumes remained. Caddy, kind, Kubernetes, registries, GitHub, object storage, and production systems were not contacted.

## Delivery invariants

CI builds web, collector, migrate, and backup once, disables Buildx provenance/SBOM before exact pushed-digest smoke and CVE gates, and runs pinned SBOM/provenance actions only after both gates. Production promotion, backup, and GitOps retain all four application digests; production chart defaults omit the backup workload and image, while enabling backup requires an explicit immutable digest. Preview carries all four application digests for its publication handoff but has no backup workload. Missing digests remain fail-closed. Delivery policy, chart, preview, backup, and immutable-digest tests passed after the final edits.

## Final local checks

The final delivery patch passed `node scripts/delivery-policy.mjs`, `node scripts/delivery-test.mjs`, `node scripts/chart-test.mjs`, `node scripts/backup-test.mjs`, `pnpm build`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `node --check` for changed scripts, and `git diff --check`. The chart check rendered the disabled production default without a backup CronJob/image and rejected an enabled backup with an empty digest. The preview checks covered four digest outputs and gate-before-attestation ordering.

Remote publication, object-storage upload/off-VM restore, Cloudflare, Google OAuth callbacks, Argo CD, and production promotion remain intentionally unverified and unauthorized.
