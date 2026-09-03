# Technology Stack Research

Research date: 2026-09-01. Sources are official documentation, specifications, repositories, and package metadata. The initial framework proposal was superseded by [ADR 0006](../adr/0006-choose-hono-and-staged-bun-runtime.md); this document separates general research facts from the accepted implementation direction.

## Verified facts

- Node.js 26 is still Current and is scheduled to enter LTS on 2026-10-28. Node.js recommends Active or Maintenance LTS for production. The migration and backup production processes still use Node.js 26.8.x, and that risk is recorded explicitly. [Node.js releases](https://nodejs.org/en/about/previous-releases) and [release schedule](https://github.com/nodejs/Release/blob/main/schedule.json)
- TypeScript 7 is stable and ships the native Go-based compiler through the standard `typescript` package and `tsc` command. Version 7.0 does not expose a programmatic compiler API, so compatibility for linting and other tools must be proven instead of assuming legacy compiler API behavior. The project configures strict ESM behavior explicitly rather than relying on defaults. [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- TanStack Start's React documentation still labels it Release Candidate even though the published package uses a 1.x version. It was considered during the initial design and is not adopted by the current product or modernization target. [TanStack Start overview](https://tanstack.com/start/latest/docs/framework/react/overview)
- tRPC 11 is described as production-ready and provides end-to-end TypeScript inference without schema generation. It was considered during the initial design but is not the selected application transport; HTTP HTML/JSON routes remain the contract. [tRPC documentation](https://trpc.io/docs)
- Zod 4 is stable. Registry metadata reported `4.5.4` as the latest stable package during the research check. It is not a current application dependency. [Zod versioning](https://zod.dev/v4/versioning)
- Drizzle ORM's stable line is 0.45.x while v1 remains prerelease. It was considered during the initial design; the current persistence boundary uses PostgreSQL through `pg` directly. [Drizzle releases](https://github.com/drizzle-team/drizzle-orm/releases) and [v0 to v1 changes](https://orm.drizzle.team/docs/v0-v1-changes)
- Kubernetes incremental observation must begin with a list and continue watching from its `resourceVersion`; a `410 Gone` response requires a fresh list. [Kubernetes API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/)
- Kubernetes recommends least-privilege RBAC, and read access to Secrets can expose their values. Tracegarden never requests Secret access. [RBAC good practices](https://kubernetes.io/docs/concepts/security/rbac-good-practices/) and [Secret good practices](https://kubernetes.io/docs/concepts/security/secrets-good-practices/)
- Google OIDC redirect URIs must exactly match registered values, and the durable identity is the token's `sub`, not email. [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect) and [ID token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- Browser `EventSource` provides server-to-client events, automatic reconnection, and last-event identity. [WHATWG Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- PostgreSQL `LISTEN/NOTIFY` payloads are small notifications rather than a durable message store. The project sends only an ID or cursor and retains authoritative data in tables. [PostgreSQL LISTEN](https://www.postgresql.org/docs/current/sql-listen.html) and [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)
- GitHub Actions can publish GHCR images with a short-lived repository token and produce build provenance; workflows should receive explicit minimum permissions. [Publishing Docker images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images) and [artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- Argo CD automatic synchronization removes the need for CI to call the cluster API directly. Pruning and self-healing are explicit choices, not defaults. [Argo CD automated sync](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)

## Current accepted direction

| Area | Current implementation | Accepted target or constraint |
|---|---|---|
| Runtime | Bun 1.3.14 for web, collector, migration, and backup; ESM | Bun adoption remains per-process; each parent Node image/entrypoint remains the rollback runtime for its migrated process |
| Language | TypeScript 7 with native `tsc` | `tsc --noEmit` remains authoritative |
| Web transport | Hono fetch listener on Bun | Existing URLs, methods, statuses, redirects, cookies, authorization, health, metrics, telemetry, and SSE contracts remain unchanged |
| Views and client | Server-rendered HTML strings, native forms, and a small `fetch`/`EventSource` client | Hono JSX may structure server views without React, hydration, or a client state framework |
| Application transport | Validated HTTP HTML/JSON routes | No React, TanStack Router, TanStack Start, tRPC, or Tailwind |
| Database | PostgreSQL 18 through `pg` | PostgreSQL remains the durable authority; no embedded database or driver replacement |
| Authentication | Better Auth + Google OAuth | Existing identity and admission contracts remain unchanged |
| Realtime | PostgreSQL notification + SSE hint + cursor query | Database rows remain authoritative |
| Tests | Node-based scripts and Playwright with disposable PostgreSQL | pnpm, native `tsc`, and Node Playwright remain development and validation tools |
| Delivery | GitHub Actions, GHCR digest, Argo CD declarations | Production runtime images move to Bun only after per-process proof |

## Evidence boundary

The web, collector, migration, and backup sources and production images use Bun with Hono where applicable. PostgreSQL and `pg` remain unchanged. Tickets 05, 06, 07, and 08 cover those process migrations; live cluster behavior and external integrations remain unverified under the existing authorization boundary. The parent Node image and entrypoint for each migrated process remain independently recoverable.
