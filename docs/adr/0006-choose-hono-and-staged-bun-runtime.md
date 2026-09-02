# Choose Hono transport and a staged Bun production runtime

Tracegarden's current implementation uses Node.js 26.8.x, Node `node:http`, server-rendered HTML strings, native forms, a small `fetch`/`EventSource` client, PostgreSQL, and the `pg` driver. This ADR records the target direction rather than claiming that migration is complete: Hono owns web transport and route composition; Hono JSX may structure server-rendered views without React or hydration; and Bun becomes the production runtime one process at a time after compatibility and behavior parity are proven. pnpm, native TypeScript `tsc --noEmit`, the Node-based Playwright toolchain, PostgreSQL, and `pg` remain. React, TanStack Router, TanStack Start, tRPC, and Tailwind are not adopted.

## Alternatives

- **Keep Node `node:http` permanently:** lowest immediate change, but preserves the current concentration of dispatch, authentication delegation, API handling, views, SSE, health, and telemetry in one module. It remains the rollback baseline during migration, not the target.
- **Adopt React, TanStack Router/Start, tRPC, or Tailwind:** rejected because the proven product behavior is server-rendered HTML with native forms and small browser enhancements. A hydrated SPA and client-state/transport framework would add dependencies and failure modes without a current product requirement; TanStack Start's RC status is an additional avoidable risk.
- **Move directly to Bun and change every process together:** rejected because a framework/runtime cutover across web, collector, migration, and backup would make regressions hard to localize. Per-process migration preserves a known-good rollback point.
- **Replace PostgreSQL or `pg` with an embedded database or Bun SQL:** rejected because PostgreSQL currently provides cross-process transactions, locks, global Timeline sequencing, `LISTEN/NOTIFY`, constraints, migration ordering, and `pg_dump`/`pg_restore`. An embedded engine would require new writer coordination, polling/notification, and recovery machinery; changing the driver would add a separate compatibility risk.

## Trade-offs

Hono adds a transport dependency and route migration work, while Hono JSX introduces a server-view compilation/runtime surface; in exchange, route composition and view ownership can be separated without changing product behavior or browser contracts. Server-rendered HTML and native forms intentionally provide less client-side interactivity than a SPA, but they keep the current accessibility, URL, redirect, cookie, and failure contracts direct and testable. A staged Node/Bun period temporarily requires two runtime paths and duplicate compatibility evidence, but limits blast radius. Retaining `pg` preserves PostgreSQL semantics while requiring explicit Bun compatibility tests for pooling, TLS, transactions, `LISTEN/NOTIFY`, cancellation, and shutdown.

## Rollback

Each migration step must pass independently and retain the previous process entrypoint, image, and acceptance evidence. If Hono transport or Hono JSX fails parity, deploy the last known-good Node `node:http` image/command and revert that step without changing public URLs or domain contracts. If a Bun process fails compatibility, restore that process's last known-good Node image/command while leaving already-proven processes unchanged. PostgreSQL schema, `pg`, security boundaries, and migration/backup contracts are not rolled back or weakened to make a runtime change pass.

## Reconsideration

Reconsider a SPA only when demonstrated product requirements need sustained client state or interaction that server-rendered HTML, native forms, `fetch`, and `EventSource` cannot satisfy, and a separate decision includes accessibility, performance, security, URL, and browser acceptance evidence. Reconsider an embedded database only if the product explicitly becomes a single-process/single-writer deployment and no longer needs the current web/collector/migrate/backup process boundaries, cross-process ordering, PostgreSQL locking/notification semantics, or PostgreSQL backup/recovery contract; a separate decision must prove equivalent durability, concurrency, migration, notification, and restore behavior.
