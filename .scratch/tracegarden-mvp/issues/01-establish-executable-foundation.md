# 01: Establish the executable foundation

**What to build:** A reproducible TypeScript 7 monorepo in which the Tracegarden web process, collector process, PostgreSQL, and migrations form a minimal runnable path. A Member can open a bilingual status screen that reports the local application's readiness, giving every later tracer bullet a proven runtime, persistence, contract, and test foundation.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] A frozen workspace install succeeds with exact dependency versions selected only after Node.js 26 and TypeScript 7 compatibility are proven.
- [x] TypeScript 7's native `tsc` is the authoritative compiler for the monorepo, and any selected tool that depends on a programmatic TypeScript compiler API has a proven compatible integration rather than an implicit legacy compiler fallback.
- [x] Strict TypeScript, ESM, formatting, linting, unit-test, production-build, and environment-validation commands are available from the workspace root and pass.
- [x] The web process reaches PostgreSQL through the repository boundary and renders a status screen without exposing configuration values.
- [x] The collector starts independently of the web request lifecycle and reports its readiness without contacting a real Cluster.
- [x] Database migrations apply successfully to a disposable PostgreSQL instance and a migration failure prevents application startup.
- [x] Simplified Chinese is the default UI language, English can be selected, and both message catalogs are exercised by an automated browser smoke test.
- [x] A minimal production web build and credential-free container smoke test pass on the local architecture.

## Answer

Implemented the executable foundation as a pnpm TypeScript 7 ESM workspace with independent web and collector processes, a repository-owned PostgreSQL migration boundary, health endpoints, bilingual status UI, Playwright browser smoke coverage, and deterministic validation scripts. The web applies migrations and verifies PostgreSQL readiness before listening; collector readiness is independent and reports `clusterContacted: false`. Browser tests provision Chromium through `pnpm exec playwright install chromium`, and both container build contexts include the build scripts. Container smoke refuses unavailable images, builds both production images, and verifies ARM64, Node `v26.8.1`, PostgreSQL `18.3`, readiness, and non-root `node` execution.

Verified with frozen installs and foundation checks in a disposable ARM64 Node `v26.8.1` workspace, plus local formatting, lint, typecheck, build, unit, Playwright, PostgreSQL migration/readiness, migration-failure, and production-memory rejection checks. The host's aggregate `pnpm check` remains expected to reject the installed Node.js `v24.14.0`; equivalent environment validation passes under the declared Node 26.8.x runtime. No live Cluster, OAuth provider, cloud account, GitHub account, or live production service was contacted.
