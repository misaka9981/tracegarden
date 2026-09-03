# Local acceptance workflow

Run the one authoritative, finite workflow from the repository root:

```sh
pnpm acceptance
```

It runs sequentially so the shared build and Docker resources cannot race:

1. format, lint, strict typecheck, and production build;
2. unit, authorization, telemetry, domain, deterministic collector, and failure-path suites;
3. real disposable PostgreSQL integration, retention, Recent Log Window bounds/redaction, and notification tests;
4. the existing bilingual browser smoke suite and `scripts/core-loop-browser.mjs`, the focused Playwright scenario;
5. offline encrypted backup/restore checks;
6. checked-in Kubernetes schema provisioning, offline production/backup Helm rendering, and strict validation;
7. offline Preview Environment, promotion, lifecycle, and delivery-policy checks; and
8. production Bun web/collector and Node migration image build and non-root read-only smoke.

The focused browser scenario uses the local identity adapter and a fresh PostgreSQL container. It configures the approved Cluster scope, feeds a fixed Pod through `DeterministicKubernetesAdapter`, verifies committed Timeline SSE delivery and cursor recovery after a missed notification, then creates structured Experiments. It rejects one Correlation Suggestion and confirms another, checks their persisted statuses and Confirmed Link, verifies that no suggestion is presented as cause, and reconstructs the history after switching from Simplified Chinese (the default) to English. Duplicate deterministic delivery remains one Timeline Entry. The PostgreSQL Timeline page, Confirmed Links, live watermark, and unread count are read from one repeatable-read snapshot; the PostgreSQL smoke pauses after the page query while a later commit completes to prove live recovery does not skip it.

The workflow runs the compiled-ESM Bun compatibility gate after the authoritative Node build and before acceptance image checks. It does not install browsers, pull images, contact Kubernetes, or invoke an external integration. The Bun gate uses exact Bun `1.3.14` (`docker.io/oven/bun:1.3.14-slim@sha256:6068a9d40e9fc5c4519891edb63dfc5935c393fe2228eb9a5b7f472b444b5ee2` is the official ARM64 reference) and proves Hono requests/SSE abort, `pg` transactions/TLS/readiness/LISTEN reconnect, Better Auth, deterministic Kubernetes collection, migration/backup crypto-filesystem-child-process paths, and signal shutdown. Web and collector now use that Bun image in production; migration and backup remain on Node as independently rollbackable processes. Container acceptance first materializes `.scratch/container-context` from the already frozen local install/store and production build, installs only production dependencies offline, and builds web, collector, and migration images with `network: none`; a missing `dist` or `node_modules` fails closed. It also runs a bounded `--no-cache --network none --pull=false` build for all four release Dockerfiles using only the generated context and preloaded pinned bases. Before removing the temporary backup tag, it runs pull-never `pg_dump --version` and `pg_restore --version` in the ARM64 non-root, read-only image and verifies a non-root effective UID; it removes only those temporary image tags and never prunes Docker globally. Compose starts the services with `--pull never --no-build`, and the image smoke never builds from a registry or runs npm/pnpm. Before running it, Docker's local image store must contain these exact references (all `docker image inspect` commands must succeed):

```sh
docker image inspect 'postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7'
docker image inspect 'node:26.8-bookworm@sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89'
docker image inspect 'docker.io/oven/bun:1.3.14-slim@sha256:6068a9d40e9fc5c4519891edb63dfc5935c393fe2228eb9a5b7f472b444b5ee2'
```

Also keep Chromium, Helm, kubeconform, and dependencies available locally. The browser, PostgreSQL, core-loop, and container smokes fail closed when their pinned images are absent; none runs `docker pull`. Each database/container/browser/process check owns cleanup; a failed step stops the workflow.

## Evidence boundary

The local workflow proves local behavior only. These boundaries remain **unverified**:

- live Kubernetes compatibility, list/watch behavior, and live RBAC;
- real Google OAuth callbacks;
- Cloudflare Access and preview ingress;
- Argo CD reconciliation and preview cleanup in a Cluster;
- remote artifact publication (including GitHub/GHCR);
- backup upload to R2 or other object storage;
- restore rehearsal against a separate live backup target; and
- production promotion.

No Google, Cloudflare, GitHub, R2/object storage, Argo CD, live Kubernetes Cluster, or Kubernetes context is required. The local Correlation Suggestions are review candidates, not causal inference, and the workflow makes no live compatibility claim.
