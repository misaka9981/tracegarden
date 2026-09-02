# 04: Prove Bun runtime compatibility

**What to build:** Establish one exact Bun runtime as a non-production compatibility target without changing package management, typechecking, Playwright, PostgreSQL driver, or production entrypoints.

**Blocked by:** 02: Adopt Hono transport on Node.

**Status:** ready-for-agent

- [ ] Pin one Bun version and ARM64-capable image according to existing immutable delivery policy.
- [ ] Run compiled ESM with the existing `pg`, Better Auth, Kubernetes client, child-process, crypto, filesystem, signal, and Web API usage.
- [ ] Prove PostgreSQL pool/TLS setup, transactions, `LISTEN/NOTIFY`, cancellation/timeouts, SSE streaming, and graceful shutdown under Bun.
- [ ] Prove read-only/non-root container behavior and health probes without changing production images.
- [ ] pnpm and `tsc --noEmit` remain authoritative; Playwright continues under its proven Node toolchain.
- [ ] A deterministic compatibility command fails on any unsupported runtime behavior and passes locally and on the authorized ARM64 VM.

## Safe stop rules

Do not switch production commands, adopt Bun's package manager, replace `pg` with `Bun.SQL`, or accept syntax-only compatibility as runtime proof.
