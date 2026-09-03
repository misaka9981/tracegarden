# 05: Run the web process on Bun

**What to build:** Make Bun the production runtime for the Hono web process while preserving the Node-based build and validation toolchain.

**Blocked by:** 03: Structure server views with Hono JSX; 04: Prove Bun runtime compatibility.

**Status:** resolved

- [x] Web startup uses Hono's Bun entrypoint and the pinned Bun runtime.
- [x] Better Auth, Cloudflare Access, cookies, redirects, capability checks, SSE, telemetry, health, metrics, migration/readiness gates, and shutdown retain parity.
- [x] The production web image is immutable, non-root, read-only, capability-dropped, ARM64-compatible, and contains no unnecessary Node runtime.
- [x] Container, browser, PostgreSQL, core-loop, chart, delivery, ARM64 VM, and authorized kind checks pass.
- [x] The previous Node web entrypoint remains recoverable from the parent commit; no runtime fallback or dual server remains in current source.

## Answer

Implemented and verified the web-only Bun runtime migration. The Hono application is served directly by Bun's `fetch` interface; no Node web listener or runtime fallback remains in the current source or production image. PostgreSQL, `pg`, pnpm, TypeScript, and the Node Playwright runner remain unchanged. The previous Node entrypoint remains recoverable from the parent commit only. The full evidence report is `evidence/05-bun-web/report.md`, including the ARM64 VM acceptance and the run-labelled authorized kind image execution/cleanup check. This ticket did not migrate the collector, migration, or backup processes; Ticket 06 separately covers the collector, while migration and backup remain on Node pending their tickets.

## Safe stop rules

Do not migrate another process, change the database driver, or weaken probes/container security to make Bun pass.
