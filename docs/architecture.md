# Architecture

## Shape

Tracegarden is one product in a monorepo with independently deployed web and collector processes. Deployment separation reflects different lifecycles, not a microservice goal.

Planned layout:

```text
apps/
  web/                 TanStack Start UI, Better Auth, tRPC, and SSE
  collector/           Kubernetes list/watch ingestion
packages/
  domain/              Timeline, experiment, correlation, and capability rules
  db/                  Drizzle schema, migrations, and repositories
  contracts/           Zod schemas and tRPC router contracts
  i18n/                Chinese and English message catalogs
  observability/       OpenTelemetry and structured logging setup
  test-support/        Local identity and Kubernetes stream adapters
deploy/
  chart/               Application Helm chart
  argocd/              ApplicationSet and example application declarations
docs/
```

## Deep modules and seams

### Cluster observation

The module accepts a Cluster identity and approved scope, then produces ordered, normalized Observations. Its interface hides initial list synchronization, `resourceVersion` checkpoints, watch reconnects, `410 Gone` relists, bounded backoff, deduplication, and raw-object projection.

The production adapter uses `@kubernetes/client-node`; tests use a deterministic stream adapter. No caller handles watch protocol details.

### Timeline

The module records Observations and Experiments, lists Timeline Entries by cursor and filters, marks Attention Items, and manages Correlation Suggestions and Confirmed Links. It owns idempotency and the rule that a suggestion is not a cause.

### Experiment journal

The module owns the structured `hypothesis -> change -> observation -> conclusion` lifecycle and its associations. Markdown is content within those fields, not a replacement for the structure.

### Identity and membership

Better Auth proves identity and owns the session. Tracegarden owns Invitations, Memberships, roles, and capabilities. Google `(issuer, sub)` is the durable external identity; email is display and invitation-matching data, not the permanent identifier.

Production uses the Google adapter. Automated tests use a local identity adapter. A Preview Environment accepts identity only after validating the configured Cloudflare Access JWT issuer and audience; arbitrary proxy headers are never trusted.

### Recent log window

This module accepts an authorized Cluster, namespace, Pod, container, and bounded tail request. It returns at most 200 lines or 1 MiB and never persists, indexes, caches, or includes the body in telemetry. It uses a Kubernetes identity separate from the collector reader.

### Live timeline

The durable database is authoritative. After a timeline transaction commits, PostgreSQL `NOTIFY` carries only an entry ID or cursor. The web process converts notifications into SSE hints; clients always query missing rows through tRPC. Reconnect and duplicate notification handling are therefore idempotent.

## Data model

The initial schema will cover:

- workspace, member, external identity, session, invitation, role, and capability grant
- cluster metadata and namespace observation scope
- normalized resource identity and latest snapshot
- observation, timeline entry, attention state, and ingestion cursor
- experiment, experiment-workload association, correlation suggestion, and confirmed link
- retention policy and immutable audit record for membership or log-access actions

Every business record carries `workspaceId`. Cluster-derived identities use Kubernetes UID plus Cluster identity; watch replay has a uniqueness constraint that prevents duplicate Observations.

## Data flow

```text
Kubernetes list/watch
  -> projection and normalization
  -> idempotent PostgreSQL transaction
  -> NOTIFY(entry cursor)
  -> web LISTEN connection
  -> SSE hint
  -> tRPC cursor query
  -> timeline UI
```

## Kubernetes authorization

The collector ServiceAccount receives `get`, `list`, and `watch` only for approved resource kinds. It receives no Secret, ConfigMap data, log, exec, port-forward, or write verbs. Namespace-scoped Roles are preferred.

Recent logs use a second ServiceAccount and the `logs:read` application capability. Future actions such as restart or rollback require a third, dedicated executor identity and an audited command model. The reader identity is never expanded into a writer.

## Runtime and persistence

- Runtime: Node.js 26.8.x, ESM
- Language: TypeScript 7 with explicit strict settings and its native `tsc` as the authoritative compiler
- Web: TanStack Start, React, TanStack Router, and TanStack Query
- Transport: tRPC 11 with Zod 4.5 runtime validation
- Database: PostgreSQL 18 with stable Drizzle ORM 0.45
- Authentication: Better Auth with Google OAuth and database sessions
- Realtime: PostgreSQL `LISTEN/NOTIFY` plus SSE hints
- Styling: Tailwind CSS, design tokens, and accessible headless primitives
- Workspace: pnpm workspaces and Turborepo

Exact dependency patches are pinned only after an install, build, and compatibility test proves the selected set works together.

## Verification strategy

- Domain tests exercise observable behavior through module interfaces.
- Deterministic collector tests cover duplicate events, disconnects, `410 Gone`, missing bookmarks, and persistence failures without sleeps.
- Repository integration tests run migrations and queries against a real disposable PostgreSQL container.
- tRPC tests cover authorization and runtime validation.
- Playwright covers admitted login, rejected login, timeline browsing, and Experiment creation using the local identity adapter rather than a real Google account.
- Container smoke tests run as non-root and exercise startup, readiness, graceful shutdown, and migration ordering.
- Kubernetes manifests are rendered and schema-validated without contacting a cluster.

Live Kubernetes compatibility remains unverified until a personal-cluster context is supplied and explicitly selected.
