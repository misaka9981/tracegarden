# Separate cluster observation from the web lifecycle

Tracegarden remains one monorepo and one product, but Kubernetes list/watch ingestion runs in a collector process separate from the web process. A long-lived, checkpointed watch has different startup, failure, and scaling semantics from an HTTP request lifecycle; the shared domain and database modules keep behavior local without forcing independently versioned microservices. The web transport is governed by [ADR 0006](0006-choose-hono-and-staged-bun-runtime.md), while this process boundary remains unchanged.
