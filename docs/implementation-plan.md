# Implementation Plan

## Observable completion

The local implementation phase is complete only when the core loop works against deterministic Kubernetes input and a real disposable PostgreSQL database, the bilingual UI passes its browser smoke tests, both production images build and run as non-root, and all deployment manifests render and validate without using a live cluster.

## Phase 1: foundation

- Initialize the Git repository on `main` without creating a remote.
- Pin Node.js, pnpm, TypeScript, and exact dependency versions.
- Create the pnpm/Turborepo workspace and planned packages.
- Add shared lint, format, typecheck, test, and environment validation.
- Prove TanStack Start, tRPC, Zod, Drizzle, and Better Auth compile together on Node 26.

Exit evidence: frozen install, typecheck, unit test, production web build, and minimal container smoke pass.

## Phase 2: identity and domain

- Add Better Auth database sessions and Google provider configuration.
- Implement Invitation, Membership, role, and capability rules.
- Add the local identity adapter for automated tests.
- Implement Experiment and Timeline behavior through domain module interfaces.
- Add Chinese and English catalogs with Chinese as default.

Exit evidence: invited and rejected identity tests, capability tests, and Experiment lifecycle tests pass.

## Phase 3: observation and timeline

- Implement list/watch ingestion with checkpoints, projection, idempotency, relist, and bounded reconnect.
- Persist Observations and Timeline Entries.
- Implement attention classification and correlation suggestions.
- Publish committed cursors through PostgreSQL notification and SSE.
- Build the timeline-first UI and confirmation workflow.

Exit evidence: deterministic failure-path tests and the complete core-loop browser test pass.

## Phase 4: bounded logs and operations

- Implement the separate Recent Log Window module and authorization path.
- Add retention cleanup, audit records, and disabled encrypted R2 backup templates.
- Add OpenTelemetry, metrics, structured logging, and health probes.
- Build non-root web and collector images.

Exit evidence: log-size and non-persistence tests, telemetry redaction tests, retention tests, and container smoke pass.

## Phase 5: delivery configuration

- Add GitHub Actions for required CI, GHCR images, SBOM, and provenance.
- Add Helm chart, scoped RBAC, network policy, migration Job, and Argo CD examples.
- Add ApplicationSet configuration for isolated non-draft PR previews.
- Document production promotion and external setup.

Exit evidence: workflows lint, charts render, schemas validate, image references use immutable digests, and no workflow contains cluster credentials.

## Deferred live verification

These checks require later user authorization and a personal-cluster context:

- Kubernetes client/server compatibility
- real list/watch behavior and namespace RBAC
- Argo CD reconciliation and preview cleanup
- ingress, Cloudflare Access, and Google OAuth callbacks
- persistent storage, backup upload, and restore rehearsal
- production release promotion
