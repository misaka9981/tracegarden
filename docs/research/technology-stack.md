# Technology Stack Research

Research date: 2026-09-01. Sources are official documentation, specifications, repositories, and package metadata. Recommendations from the initial investigation were superseded where the final design deliberately accepted more risk.

## Verified facts

- Node.js 26 is still Current and is scheduled to enter LTS on 2026-10-28. Node.js recommends Active or Maintenance LTS for production. Tracegarden nevertheless selects Node 26 to exercise the current runtime and records that risk explicitly. [Node.js releases](https://nodejs.org/en/about/previous-releases) and [release schedule](https://github.com/nodejs/Release/blob/main/schedule.json)
- TypeScript 7 is stable and ships the native Go-based compiler through the standard `typescript` package and `tsc` command. Version 7.0 does not expose a programmatic compiler API, so the foundation phase must prove compatibility for linting and other tools instead of assuming legacy compiler API behavior. The project will configure strict ESM behavior explicitly rather than relying on defaults. [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- TanStack Start's React documentation still labels it Release Candidate even though the published package uses a 1.x version. Tracegarden selects it as its web framework with an explicit upgrade budget. [TanStack Start overview](https://tanstack.com/start/latest/docs/framework/react/overview)
- tRPC 11 is described as production-ready and provides end-to-end TypeScript inference without schema generation. Runtime validation remains necessary. [tRPC documentation](https://trpc.io/docs)
- Zod 4 is stable. Registry metadata reported `4.5.4` as the latest stable package during the research check. [Zod versioning](https://zod.dev/v4/versioning)
- Drizzle ORM's stable line is 0.45.x while v1 remains prerelease. Tracegarden selects the stable line. [Drizzle releases](https://github.com/drizzle-team/drizzle-orm/releases) and [v0 to v1 changes](https://orm.drizzle.team/docs/v0-v1-changes)
- Kubernetes incremental observation must begin with a list and continue watching from its `resourceVersion`; a `410 Gone` response requires a fresh list. [Kubernetes API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/)
- Kubernetes recommends least-privilege RBAC, and read access to Secrets can expose their values. Tracegarden never requests Secret access. [RBAC good practices](https://kubernetes.io/docs/concepts/security/rbac-good-practices/) and [Secret good practices](https://kubernetes.io/docs/concepts/security/secrets-good-practices/)
- Google OIDC redirect URIs must exactly match registered values, and the durable identity is the token's `sub`, not email. [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect) and [ID token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- Browser `EventSource` provides server-to-client events, automatic reconnection, and last-event identity. [WHATWG Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- PostgreSQL `LISTEN/NOTIFY` payloads are small notifications rather than a durable message store. The project sends only an ID or cursor and retains authoritative data in tables. [PostgreSQL LISTEN](https://www.postgresql.org/docs/current/sql-listen.html) and [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)
- GitHub Actions can publish GHCR images with a short-lived repository token and produce build provenance; workflows should receive explicit minimum permissions. [Publishing Docker images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images) and [artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- Argo CD automatic synchronization removes the need for CI to call the cluster API directly. Pruning and self-healing are explicit choices, not defaults. [Argo CD automated sync](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)

## Final technology decisions

| Area | Decision | Stability note |
|---|---|---|
| Runtime | Node.js 26.8.x | Current until scheduled LTS transition |
| Language | TypeScript 7 | Stable native compiler; programmatic tooling compatibility must be proven |
| Web | TanStack Start + React | TanStack Start remains RC |
| Data fetching | TanStack Query | Stable major selected at install |
| Typed transport | tRPC 11 + Zod 4.5 | Stable |
| Database | PostgreSQL 18 | Supported major |
| ORM | Drizzle ORM 0.45.x | Stable line; do not use v1 RC |
| Authentication | Better Auth + Google OAuth | Exact adapter compatibility must be proven |
| Realtime | PostgreSQL notification + SSE hint + cursor query | Standards-based; database remains authoritative |
| Tests | Vitest, Playwright, disposable real PostgreSQL | Exact patches selected after compatibility proof |
| Delivery | GitHub Actions, GHCR digest, Argo CD | Live cluster remains unverified |

## Evidence boundary

No dependency set has been installed and no combination has been compiled yet. Package compatibility, Kubernetes client version, image architecture, Helm rendering, Argo CD behavior, and external integrations remain unverified until the implementation plan produces direct evidence.
