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
pnpm test:browser
pnpm test:container
pnpm test:postgres
```

Run the status page without a database for a local HTTP smoke run:

```sh
NODE_ENV=test DATABASE_MODE=memory pnpm start
```

For PostgreSQL-backed development, copy `.env.example`, start `postgres:18.3-alpine` with `docker compose up -d postgres`, and run the web process with `DATABASE_URL` set. `pnpm db:migrate` applies the repository-owned migration after a build. The web process applies migrations before listening; a migration or readiness failure exits without serving requests. Start the independent collector with `pnpm collector`; it reports ready without contacting a Cluster.

`pnpm env:check` requires Node.js 26.8.x and validates production database configuration. The current development host may report this check as unavailable until Node 26 is installed.

## Agreed baseline

- Node.js 26.8.x and TypeScript 7.0.2
- pnpm workspaces and Turborepo task metadata
- PostgreSQL 18 with a repository-owned migration boundary
- TanStack Start, React, tRPC, Zod, Drizzle, Better Auth, and Kubernetes adapters are subsequent foundation/domain increments; this ticket deliberately keeps the executable path dependency-light.

## Safety boundary

No command in this repository contacts a live Kubernetes context, cloud account, GitHub account, OAuth provider, or other external production service. Live Kubernetes compatibility and external integration checks remain unverified until separately authorized.
