# 15: Run migrations and production processes as non-root

**What to build:** Maintainers can build and run production web and collector images with minimal privileges, predictable configuration, and a migration gate that prevents incompatible rollout. Container behavior is verifiable locally without credentials or a live Cluster.

**Blocked by:** 14: Expose safe operational health and telemetry.

**Status:** resolved

- [x] Production web and collector images build reproducibly for the supported local architecture from the frozen dependency graph.
- [x] Both application processes run as a non-root user with a read-only application filesystem except for explicitly required ephemeral locations.
- [x] Images contain only production runtime requirements and do not embed source credentials, local configuration, or development-only services.
- [x] A one-shot migration process applies pending migrations before application rollout.
- [x] Migration failure is required and blocks web and collector readiness rather than being treated as best-effort.
- [x] Container smoke tests exercise startup, readiness, conservative liveness, graceful shutdown, invalid configuration, and migration ordering.
- [x] Collector smoke tests remain credential-free and do not contact a Kubernetes context.
- [x] Image and process telemetry preserve the protected-content rules established by the operational slice.

## Answer

Implemented the production container hardening and migration gate. Web and collector entrypoints remember early SIGTERM/SIGINT and close as soon as startup completes; web shutdown marks readiness false, drains HTTP/SSE connections before closing the database, and closes the database in a finally path. Compose now runs a one-shot migration service and blocks web/collector startup on migration failure. Production collector startup requires and passes `TIMELINE_CURSOR_SECRET`.

Web, collector, and migration images use digest-pinned ARM64 Node bases, frozen dependencies, pruned runtime contents, non-root `node`, read-only filesystems, dropped capabilities, and bounded `/tmp`. Container smoke covers successful and failed migration gates, readiness/liveness, numeric UID/GID, read-only behavior, startup/shutdown, secret absence, architecture, and no Kubernetes credentials. `pnpm test`, `pnpm test:browser`, `pnpm test:postgres`, `pnpm test:container`, formatting, lint, typecheck, build, and `git diff --check` passed. The aggregate `pnpm check` remains blocked by the host's Node v24.14.0 versus the required Node 26.8.x. No files are staged; no external account, VM, or live Kubernetes context was contacted.
