# Tracegarden

Tracegarden is a self-hosted change and incident timeline for a personal Kubernetes lab. It preserves Kubernetes observations, lets operators record structured experiments, and helps them examine possible relationships without claiming unproven causality.

## Foundation

The repository is a pnpm TypeScript 7 monorepo with independent web and collector processes. The foundation includes a PostgreSQL migration boundary, health endpoints, a bilingual status page (Simplified Chinese by default), and credential-free local smoke tests. Browser checks use Playwright; container checks fail rather than pass when the pinned Node 26 base image is unavailable locally.

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:backup
pnpm test:browser
pnpm test:container
pnpm test:postgres
pnpm test:chart
pnpm chart:render
pnpm chart:validate
pnpm acceptance
```

Run the status page without a database for a local HTTP smoke run:

```sh
NODE_ENV=test DATABASE_MODE=memory pnpm start
```

For PostgreSQL-backed development, copy `.env.example`, start `postgres:18.3-alpine` with `docker compose up -d postgres`, and run the web process with `DATABASE_URL` set. `pnpm db:migrate` applies the repository-owned migrations after a build. The production Compose path builds ARM64-pinned web, collector, and one-shot migration images; web and collector wait for the migration gate, verify its committed state without running migrations, and still fail closed if migrations or readiness checks fail. Both application images run as `node` with a read-only root and `/tmp` as their only writable filesystem. Start the independent collector with `DATABASE_URL` set; without explicit Kubernetes settings its adapter remains inert and does not contact a Cluster.

`pnpm env:check` requires Node.js 26.8.x and validates production database and `TIMELINE_CURSOR_SECRET` configuration. The current development host may report this check as unavailable until Node 26 is installed.

## Agreed baseline

- Node.js 26.8.x and TypeScript 7.0.2
- pnpm workspaces and Turborepo task metadata
- PostgreSQL 18 with a repository-owned migration boundary
- TanStack Start, React, tRPC, Zod, Drizzle, and Kubernetes adapters remain subsequent foundation/domain increments; Better Auth now owns production Google identity and sessions.

## Safety boundary

No command in this repository contacts a live Kubernetes context, cloud account, GitHub account, OAuth provider, or other external production service. Live Kubernetes compatibility and external integration checks remain unverified until separately authorized.
