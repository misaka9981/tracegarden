# 01: Record the target stack decision

**What to build:** Make Hono + Bun + PostgreSQL the canonical implementation direction and remove stale claims that the current web uses TanStack Start, React, TanStack Router, TanStack Query, Tailwind, or tRPC.

**Blocked by:** None.

**Status:** ready-for-agent

- [ ] Add an ADR recording the accepted alternatives, trade-offs, rollback strategy, and conditions for reconsidering a SPA or embedded database.
- [ ] Reconcile `.scratch/tracegarden-mvp/spec.md`, architecture docs, and dependency descriptions with observed source and the accepted target.
- [ ] Preserve domain terminology and behavior contracts; this ticket changes no runtime behavior.
- [ ] Repository search finds no unsupported statement that the implemented application already uses the rejected stack.
- [ ] Formatting, documentation checks, and `git diff --check` pass.

## Safe stop rules

Do not change application code or dependency versions. Stop if a product behavior—not merely an implementation claim—would need reinterpretation.
