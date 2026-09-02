# 01: Record the target stack decision

**What to build:** Make Hono + Bun + PostgreSQL the canonical implementation direction and remove stale claims that the current web uses TanStack Start, React, TanStack Router, TanStack Query, Tailwind, or tRPC.

**Blocked by:** None.

**Status:** resolved

- [x] Add an ADR recording the accepted alternatives, trade-offs, rollback strategy, and conditions for reconsidering a SPA or embedded database.
- [x] Reconcile `.scratch/tracegarden-mvp/spec.md`, architecture docs, and dependency descriptions with observed source and the accepted target.
- [x] Preserve domain terminology and behavior contracts; this ticket changes no runtime behavior.
- [x] Repository search finds no unsupported statement that the implemented application already uses the rejected stack.
- [x] Formatting, documentation checks, and `git diff --check` pass.

## Safe stop rules

Do not change application code or dependency versions. Stop if a product behavior—not merely an implementation claim—would need reinterpretation.

## Answer

Recorded the accepted target in `docs/adr/0006-choose-hono-and-staged-bun-runtime.md`: Hono owns web transport and route composition; Hono JSX may structure server-rendered HTML without React or hydration; Bun is adopted as the production runtime per process after compatibility proof; pnpm, native `tsc --noEmit`, Node Playwright, PostgreSQL, and `pg` remain. The ADR documents rejected framework/runtime/database alternatives, trade-offs, per-process rollback to the current Node images/commands, and evidence required before reconsidering a SPA or embedded database.

Reconciled the MVP spec, architecture, implementation plan, research, operations, acceptance, delivery, README, and superseded ADR wording with the observed Node/`node:http` implementation and the staged target. Existing URLs, methods, status/redirect/cookie/authentication, SSE, health, metrics, telemetry, migration, backup, restore, and domain contracts remain unchanged. No application code, dependency manifest, lockfile, or runtime behavior changed. Validation passed for the required format, diff, and documentation searches; no files are staged after the local commit.
