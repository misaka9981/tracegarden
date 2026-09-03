# Architecture

## Shape

Tracegarden is one product in a monorepo with independently deployed web and collector processes. Deployment separation reflects different lifecycles, not a microservice goal.

Current layout and target seam:

```text
apps/
  web/                 Bun + Hono transport, HTML views, Better Auth, JSON APIs, and SSE
  collector/           Kubernetes list/watch ingestion
  migrate/             PostgreSQL migration gate
packages/
  cluster/             Kubernetes scope, normalization, and stream adapters
  contracts/           Shared process/status types
  db/                  PostgreSQL `pg` boundary, migrations, and repositories
  delivery/            Deployment and delivery policy helpers
  domain/              Timeline, experiment, correlation, and capability rules
  i18n/                Chinese and English message catalogs
  identity/            Better Auth, memberships, invitations, and capabilities
  logs/                Bounded recent-log access
  telemetry/           OpenTelemetry-compatible telemetry setup
deploy/
  chart/               Application Helm chart
  docker/              Production process images
  gitops/              Pull-based deployment declarations
  preview/             Isolated Preview Environment declarations
docs/
```

The web transport uses Bun's fetch listener and Hono route composition with Hono JSX view modules; it does not change the domain or URL contracts. Web, collector, migration, and backup now run on Bun 1.3.14 after their independent compatibility steps. See [ADR 0006](adr/0006-choose-hono-and-staged-bun-runtime.md).

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

The durable database is authoritative. After a timeline transaction commits, PostgreSQL `NOTIFY` carries only an entry ID or cursor. The web process converts notifications into SSE hints; clients always query missing rows through the HTTP JSON route. Reconnect and duplicate notification handling are therefore idempotent.

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
  -> HTTP JSON cursor query
  -> timeline UI
```

## Kubernetes authorization

The collector ServiceAccount receives `get`, `list`, and `watch` only for approved resource kinds. It receives no Secret, ConfigMap data, log, exec, port-forward, or write verbs. Namespace-scoped Roles are preferred.

Recent logs use a second ServiceAccount and the `logs:read` application capability. Future actions such as restart or rollback require a third, dedicated executor identity and an audited command model. The reader identity is never expanded into a writer.

## Runtime and persistence

- Production runtime: Bun 1.3.14 for web, collector, migration, and backup
- Language: TypeScript 7 with explicit strict settings and its native `tsc` as the authoritative compiler
- Web transport: Hono route composition; the production web entrypoint uses Bun's native server
- Views and client: server-rendered HTML strings, native forms, and a small `fetch`/`EventSource` client today; Hono JSX may structure those views without React or hydration
- Application transport: existing validated HTTP HTML/JSON routes; no tRPC
- Database: PostgreSQL 18 with the existing `pg` driver and repository boundary
- Authentication: Better Auth with Google OAuth and database sessions
- Realtime: PostgreSQL `LISTEN/NOTIFY` plus SSE hints
- Styling: existing page styles; no Tailwind
- Development and validation: pnpm workspaces, native `tsc --noEmit`, and Node-based Playwright

The parent Node web, collector, migration, and backup images and entrypoints remain independent rollback baselines in Git history. Exact dependency changes for each migration step are selected only in that step and do not change PostgreSQL, `pg`, or the validation toolchain.

## Verification strategy

- Domain tests exercise observable behavior through module interfaces.
- Deterministic collector tests cover duplicate events, disconnects, `410 Gone`, missing bookmarks, and persistence failures without sleeps.
- Repository integration tests run migrations and queries against a real disposable PostgreSQL container.
- HTTP route tests cover authorization and runtime validation.
- Playwright covers admitted login, rejected login, timeline browsing, and Experiment creation using the local identity adapter rather than a real Google account.
- Container smoke tests run as non-root and exercise startup, readiness, graceful shutdown, and migration ordering.
- Kubernetes manifests are rendered and schema-validated without contacting a cluster.

Production Kubernetes compatibility and external integrations remain unverified; bounded authorized VM/kind evidence is recorded separately and does not replace production verification.
