# Tracegarden Stack Modernization

Status: ready-for-agent

## Problem

Tracegarden's product behavior is proven, but the web process concentrates HTTP dispatch, authentication delegation, API handlers, server-rendered HTML, SSE, health, and telemetry in one large `node:http` module. The application does not need a hydrated React SPA today, while changing framework, runtime, and database together would make regressions difficult to isolate.

## Target

Modernize one seam at a time:

- Hono owns web transport and route composition.
- Server-rendered HTML, native forms, and the small `fetch`/`EventSource` client remain the UI model.
- Hono JSX may structure server views without React or hydration.
- Bun becomes the production runtime after compatibility is proven per process.
- pnpm, TypeScript `tsc --noEmit`, and the Node-based Playwright toolchain remain development and validation tools until a separate decision changes them.
- PostgreSQL remains the durable authority.

## Decisions

- Do not adopt React, TanStack Router, or TanStack Start for the current product behavior.
- Do not run Hono and TanStack Start as competing server frameworks.
- Do not replace PostgreSQL with SQLite, PGlite, DuckDB, or pgrust.
- Do not replace `pg` with `Bun.SQL` during the runtime migration.
- Preserve the independently deployed web, collector, migrate, and backup processes.
- Preserve every existing URL, method, status, redirect, cookie, authorization, SSE, health, metrics, telemetry, migration, backup, and restore contract.
- Every migration step must pass independently and retain a clear rollback point.

## Why PostgreSQL remains

PostgreSQL currently supplies cross-process transactions, row and advisory locks, global Timeline sequencing, `LISTEN/NOTIFY`, schema constraints, migration ordering, and `pg_dump`/`pg_restore`. Embedded alternatives would require new polling, writer coordination, notification, and recovery machinery. The existing memory adapter remains sufficient for lightweight deterministic tests.

## Completion

The effort is complete when all production processes run on one exact Bun version, the web uses Hono and maintainable server view modules, Node is no longer required in production images, PostgreSQL behavior is unchanged, and local, ARM64 VM, and authorized kind acceptance pass without weakening security or delivery controls.

## Out of scope

- React, TanStack Router, TanStack Start, SPA hydration, streaming React SSR, or client state frameworks.
- Bun as package manager, TypeScript typechecker, or Playwright runner.
- Database-engine or database-driver replacement.
- Product feature or URL redesign.
- Any live third-party integration or production promotion.
