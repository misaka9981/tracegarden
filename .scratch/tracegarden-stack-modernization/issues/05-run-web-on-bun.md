# 05: Run the web process on Bun

**What to build:** Make Bun the production runtime for the Hono web process while preserving the Node-based build and validation toolchain.

**Blocked by:** 03: Structure server views with Hono JSX; 04: Prove Bun runtime compatibility.

**Status:** ready-for-agent

- [ ] Web startup uses Hono's Bun entrypoint and the pinned Bun runtime.
- [ ] Better Auth, Cloudflare Access, cookies, redirects, capability checks, SSE, telemetry, health, metrics, migration/readiness gates, and shutdown retain parity.
- [ ] The production web image is immutable, non-root, read-only, capability-dropped, ARM64-compatible, and contains no unnecessary Node runtime.
- [ ] Container, browser, PostgreSQL, core-loop, chart, delivery, ARM64 VM, and authorized kind checks pass.
- [ ] The previous Node web entrypoint remains recoverable from the parent commit; no runtime fallback or dual server remains in current source.

## Safe stop rules

Do not migrate another process, change the database driver, or weaken probes/container security to make Bun pass.
