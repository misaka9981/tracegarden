# 04: Prove Bun runtime compatibility

**What to build:** Establish one exact Bun runtime as a non-production compatibility target without changing package management, typechecking, Playwright, PostgreSQL driver, or production entrypoints.

**Blocked by:** 02: Adopt Hono transport on Node.

**Status:** resolved

- [x] Pin one Bun version and ARM64-capable image according to existing immutable delivery policy.
- [x] Run compiled ESM with the existing `pg`, Better Auth, Kubernetes client, child-process, crypto, filesystem, signal, and Web API usage.
- [x] Prove PostgreSQL pool/TLS setup, transactions, `LISTEN/NOTIFY`, cancellation/timeouts, SSE streaming, and graceful shutdown under Bun.
- [x] Prove read-only/non-root container behavior and health probes without changing production images.
- [x] pnpm and `tsc --noEmit` remain authoritative; Playwright continues under its proven Node toolchain.
- [x] A deterministic compatibility command fails on any unsupported runtime behavior and passes locally and on the authorized ARM64 VM.

## Answer

Bun `1.3.14` remains the non-production compatibility target with the existing exact ARM64 image. The ARM64 container job now installs the pinned pnpm version, runs `pnpm install --frozen-lockfile` and `pnpm build`, and only then runs the container and Bun gates. The Bun gate now uses a real max-one `pg.Pool` readiness acquisition held past a bounded deadline and checks late-client destruction and recovered pool counts. It also builds a request through an explicit synthetic `KubeConfig`/`CoreV1Api` configuration and checks endpoint, bearer-auth, and request metadata without contacting a Cluster; deterministic collection remains unchanged. The web SSE path no longer monkey-patches `ServerResponse.write` or destroys responses on temporary backpressure; the Node regression checks write-false/drain continuity and exactly-once explicit cleanup. Production commands/images, pnpm, `tsc`, Playwright, and `pg` remain unchanged.

Verified locally: frozen install, format, typecheck, build, a direct Bun installed-client-node request-construction probe, and Node unit/regression suites. On the authorized ARM64 VM (`aarch64`, Docker `linux/arm64`), the pinned Bun/PostgreSQL gate, clean ARM64 container smoke, and full `pnpm acceptance` passed from the clean test archive. The local full workflow was not rerun past its shared Docker VM no-space condition; all remote databases were disposable and no Cluster or protected values were contacted.

## Safe stop rules

Do not switch production commands, adopt Bun's package manager, replace `pg` with `Bun.SQL`, or accept syntax-only compatibility as runtime proof.
