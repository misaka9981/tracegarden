# Separate cluster observation from the web lifecycle

Tracegarden remains one monorepo and one product, but Kubernetes list/watch ingestion runs in a collector process separate from the TanStack web process. A long-lived, checkpointed watch has different startup, failure, and scaling semantics from an HTTP request lifecycle; the shared domain and database modules keep behavior local without forcing independently versioned microservices.
