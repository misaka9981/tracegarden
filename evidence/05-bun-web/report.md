# Ticket 05 web-on-Bun evidence

Run: `tracegarden-ticket05-20260903T031500Z`
Validation scope: the authorized ARM64 VM `ubuntu@161.33.30.111` and the named kind context `kind-k8s-cluster-v137`. All SSH and remote commands used BatchMode, IdentitiesOnly, ConnectTimeout, and bounded `timeout` wrappers. No credentials or unrelated resources were inspected.

## Automated evidence

The exact source tree containing the Ticket 05 changes passed the following on the authorized ARM64 VM with Node 22 host tooling and the pinned Bun 1.3.14 image:

```text
pnpm typecheck                 passed
pnpm build                     passed
pnpm test                      passed
pnpm test:bun                  passed
pnpm test:browser              passed
node scripts/core-loop-browser.mjs  passed
pnpm test:postgres             passed
pnpm test:chart                passed
pnpm delivery:validate         passed
pnpm delivery:policy           passed
pnpm acceptance                passed
```

The acceptance run used the exact Bun image already established by Ticket 04:
`docker.io/oven/bun:1.3.14-slim@sha256:6068a9d40e9fc5c4519891edb63dfc5935c393fe2228eb9a5b7f472b444b5ee2`.
The web image ran as `bun`, read-only, non-root, capability-dropped, and ARM64; the collector remained on its Node image. The web production image contains the Bun entrypoint and not the Node web entrypoint. Existing Hono request, auth, cookie/redirect, capability, SSE, telemetry, probe, migration, and shutdown checks passed through the existing suites.

## Authorized kind check

The authorized context reported kind Kubernetes `v1.37.0` on ARM64 control-plane and worker nodes. The current ARM64 web image was loaded only into those two named nodes. A run-labelled Pod in `tg05-bun-web-kind-20260903` used `imagePullPolicy: Never`, numeric UID/GID 1000, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, and dropped all capabilities. Its image configuration had the real Bun web entrypoint and no command override:

```text
entrypoint=["/usr/local/bin/docker-entrypoint.sh"] ["bun","dist/apps/web/src/bun.js"]
health=status=200 body={"service":"tracegarden-web","status":"alive","liveness":"alive"}
```

The health result came from a bounded `kubectl exec` running Bun `fetch("http://127.0.0.1:3000/health/live")` inside the running Pod, after PostgreSQL migration completed and the Pod readiness probe passed. Image loads were capped at 60 seconds each; PostgreSQL readiness at 45 seconds; migration at 90 seconds; web readiness at 60 seconds; health at 10 seconds; namespace cleanup at 30 seconds. The namespace, temporary database container, and run image tag were removed. Caddy and both existing kind node container IDs and running states matched before/after. No production credentials were inspected or used.

## Limitations

The VM host used Node 22 for the Node-based test runner because the pinned Node 26 tool image is the repository's production/CI baseline. No third-party OAuth, Cloudflare, registry, object-storage, production GitOps, or production Kubernetes boundary was contacted. The previous Node web entrypoint remains recoverable from the parent Git commit and is excluded from the Bun production image; no Bun-to-Node fallback is configured.
