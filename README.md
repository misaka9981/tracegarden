# Tracegarden

Tracegarden is a self-hosted change and incident timeline for a personal Kubernetes lab. It preserves Kubernetes observations, lets operators record structured experiments, and helps them examine possible relationships without claiming unproven causality.

## Foundation

The repository is a pnpm TypeScript 7 monorepo with independent web and collector processes. The foundation includes a PostgreSQL migration boundary, health endpoints, a bilingual status page (Simplified Chinese by default), and credential-free local smoke tests. Browser checks use Playwright; container checks fail rather than pass when a pinned Bun 1.4.0 or PostgreSQL image is unavailable locally. Node.js remains the host toolchain for pnpm, TypeScript, and validation scripts.

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

For PostgreSQL-backed development, copy `.env.example`, start `postgres:18.3-alpine` with `docker compose up -d postgres`, and run the web process with `DATABASE_URL` set. `pnpm db:migrate` applies the repository-owned migrations after a build. The production Compose path builds ARM64-pinned web, collector, and one-shot migration images; web and collector wait for the migration gate, verify its committed state without running migrations, and still fail closed if migrations or readiness checks fail. Web, collector, migration, and backup run as pinned Bun `1.4.0`; all application images use a read-only root and `/tmp` as their only writable filesystem. Start the independent collector with `DATABASE_URL` set; without explicit Kubernetes settings its adapter remains inert and does not contact a Cluster.

`pnpm env:check` requires Node.js 26.8.x and validates production database and `TIMELINE_CURSOR_SECRET` configuration. The current development host may report this check as unavailable until Node 26 is installed.

## Agreed baseline

- Web, collector, migration, and backup production entrypoints use Bun 1.4.0. TypeScript 7.0.2 and ESM remain unchanged; the parent commits retain the Node rollback runtimes.
- pnpm workspaces and Turborepo task metadata remain the development workspace.
- The web uses Hono with Bun's production entrypoint, server-rendered Hono JSX, native forms, and a small `fetch`/`EventSource` client without React or hydration.
- PostgreSQL 18 and the repository-owned `pg` migration/data boundary remain unchanged.
- Better Auth and Kubernetes adapters are implemented; React, TanStack Router, TanStack Start, tRPC, Tailwind, Zod, and Drizzle are not part of the current or accepted target stack. See [ADR 0006](docs/adr/0006-choose-hono-and-staged-bun-runtime.md).

## Safety boundary

No command in this repository contacts a live Kubernetes context, cloud account, GitHub account, OAuth provider, or other external production service. Live Kubernetes compatibility and external integration checks remain unverified until separately authorized.
