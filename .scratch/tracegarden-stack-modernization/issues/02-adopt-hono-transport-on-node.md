# 02: Adopt Hono transport on Node

**What to build:** Replace the web process's hand-written `node:http` method/path dispatcher with one Hono application while retaining Node as the runtime and preserving observable behavior.

**Blocked by:** 01: Record the target stack decision.

**Status:** resolved

- [x] Pin compatible Hono 4.13.5 and `@hono/node-server` 2.1.1 versions after frozen install/build proof.
- [x] Hono owns route matching and shared request tracing middleware; store, identity, telemetry, and domain modules remain transport-independent.
- [x] Existing paths, aliases, methods, query parsing, payload validation, status codes, 302/303 redirects, headers, and response bodies remain compatible.
- [x] Better Auth delegation, Cloudflare Access, session cookies, capability authorization, health, readiness, metrics, and no-store behavior remain fail-closed.
- [x] Timeline SSE preserves ready/hint events, streaming headers, durable cursor recovery, duplicate tolerance, and graceful disconnect cleanup.
- [x] Node remains a tested rollback entrypoint.
- [x] `pnpm acceptance` and focused HTTP/SSE contract checks pass.

## Safe stop rules

Do not introduce React, TanStack, Bun, a second public route set, or a new transport abstraction. Do not retain a permanent catch-all legacy router after all routes migrate.

## Answer

Implemented the Node Hono transport with pinned Hono 4.13.5 and `@hono/node-server` 2.1.1 dependencies. The explicit Hono route table owns URL matching, shared request tracing middleware carries correlation context, the official Node adapter bridges requests to the existing domain-independent seams, and a WHATWG response bridge preserves native HTML, JSON, cookie, redirect, and SSE streaming behavior. Added focused route mismatch and unknown-route assertions. Frozen install, format, lint, typecheck, build, unit, browser, core-loop, PostgreSQL, container, chart, delivery, and full `pnpm acceptance` validation passed on the available Node 24 host (with expected Node 26 engine warnings); Node 26.8 container smoke also passed.
