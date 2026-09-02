# 02: Adopt Hono transport on Node

**What to build:** Replace the web process's hand-written `node:http` method/path dispatcher with one Hono application while retaining Node as the runtime and preserving observable behavior.

**Blocked by:** 01: Record the target stack decision.

**Status:** ready-for-agent

- [ ] Pin compatible Hono and Node adapter versions after frozen install/build proof.
- [ ] Hono owns route matching and shared request middleware; store, identity, telemetry, and domain modules remain transport-independent.
- [ ] Existing paths, aliases, methods, query parsing, payload validation, status codes, 302/303 redirects, headers, and response bodies remain compatible.
- [ ] Better Auth delegation, Cloudflare Access, session cookies, capability authorization, health, readiness, metrics, and no-store behavior remain fail-closed.
- [ ] Timeline SSE preserves ready/hint events, streaming headers, durable cursor recovery, duplicate tolerance, and graceful disconnect cleanup.
- [ ] Node remains a tested rollback entrypoint.
- [ ] `pnpm acceptance` and focused HTTP/SSE contract checks pass.

## Safe stop rules

Do not introduce React, TanStack, Bun, a second public route set, or a new transport abstraction. Do not retain a permanent catch-all legacy router after all routes migrate.
