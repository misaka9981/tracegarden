# 09: Consolidate Bun production delivery

**What to build:** Remove obsolete production Node runtime surfaces after every process-specific Bun migration passes, and make delivery evidence describe one coherent Bun runtime stack.

**Blocked by:** 05: Run the web process on Bun; 06: Run the collector process on Bun; 07: Run migrations on Bun; 08: Run backup tooling on Bun.

**Status:** ready-for-agent

- [ ] Web, collector, migrate, and backup use the same exact Bun runtime version and immutable base policy.
- [ ] Obsolete Node production images, adapters, commands, shims, and documentation are removed; pnpm, TypeScript, and Node Playwright tooling remain only where intentionally required for development/validation.
- [ ] CI builds each image once, smoke/CVE-gates exact published digests, and attaches SBOM/provenance only after gates pass.
- [ ] Helm, preview, promotion, backup, and GitOps declarations carry all four Bun image digests.
- [ ] Offline delivery policy, container clean-cache, chart/preview validation, and `pnpm acceptance` pass.

## Safe stop rules

Do not remove a Node development tool merely to claim an all-Bun repository. Do not publish, push, or promote without separate authorization.
