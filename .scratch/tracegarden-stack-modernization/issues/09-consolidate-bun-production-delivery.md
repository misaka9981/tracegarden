# 09: Consolidate Bun production delivery

**What to build:** Remove obsolete production Node runtime surfaces after every process-specific Bun migration passes, and make delivery evidence describe one coherent Bun runtime stack.

**Blocked by:** 05: Run the web process on Bun; 06: Run the collector process on Bun; 07: Run migrations on Bun; 08: Run backup tooling on Bun.

**Status:** resolved

- [x] Web, collector, migrate, and backup use the same exact Bun runtime version and immutable base policy.
- [x] Obsolete Node production images, adapters, commands, shims, and documentation are removed; pnpm, TypeScript, and Node Playwright tooling remain only where intentionally required for development/validation.
- [x] CI builds each image once, smoke/CVE-gates exact published digests, and attaches SBOM/provenance only after gates pass.
- [x] Helm, preview, promotion, backup, and GitOps declarations carry all four Bun image digests.
- [x] Offline delivery policy, container clean-cache, chart/preview validation, and `pnpm acceptance` pass.

## Answer

Resolved against the four process-specific Bun migrations. Web, collector, migrate, and backup use the shared immutable Bun `1.3.14` ARM64 base; the obsolete Node production-image prerequisite was removed without removing Node from the pnpm, TypeScript, Playwright, or validation toolchain. The auxiliary lifecycle-controller Node image remains intentionally separate. CI still builds each release image once, disables Buildx attestations before the exact-digest smoke/CVE gate, and attaches pinned SBOM/provenance only after that gate. Production promotion, backup, and GitOps declarations carry all four application digests; production chart defaults intentionally select no backup image, and enabling backup requires an explicit immutable digest. Preview carries all four application digests for the publication handoff but has no backup workload. Missing digests remain fail-closed.

Evidence: `evidence/09-bun-production-delivery/report.md`. No publication, push, promotion, or external integration was performed.

## Safe stop rules

Do not remove a Node development tool merely to claim an all-Bun repository. Do not publish, push, or promote without separate authorization.
