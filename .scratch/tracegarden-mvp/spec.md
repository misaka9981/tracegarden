# Tracegarden MVP

Status: ready-for-agent

## Problem Statement

Operators working with Kubernetes can see current resource state in dashboards and operational metrics in monitoring systems, but they lack a durable account of what changed, which symptoms followed, what they tried, and what they concluded. Reconstructing an operational sequence later requires correlating transient Kubernetes state with human memory, and tools that equate temporal proximity with causality can create false confidence.

Tracegarden needs to preserve Kubernetes-derived facts and structured human experiments in one durable, shared Timeline. It must help Members inspect possible relationships while keeping Correlation Suggestions explicitly separate from Confirmed Links. The first release must serve a small shared Workspace safely, without gaining Kubernetes write access, retaining container logs, or depending on unverified production infrastructure.

## Solution

Build the Tracegarden MVP as a self-hosted, bilingual application with independently deployed web and collector processes backed by PostgreSQL. An owner connects one Cluster, approves namespaces to observe, admits Members through Invitations, and grants roles that resolve to Capabilities. The collector converts supported Kubernetes resource state and Kubernetes Events into normalized, durable Observations. The application presents Observations and Experiments as cursor-paginated Timeline Entries, highlights Attention Items, and provides live updates within five seconds under normal conditions.

Members can record structured Experiments, review Correlation Suggestions, and explicitly confirm or reject them. A Confirmed Link records human judgment; the product never presents an unconfirmed relationship as cause. Owners can request a tightly bounded, non-persistent recent log window through a separate identity and Capability. Retention, audit records, health signals, non-root containers, scoped Kubernetes RBAC, pull-based GitOps, and isolated Preview Environments provide the operational boundary for the first release.

## User Stories

1. As an operator, I want Kubernetes changes and human Experiments in one Timeline, so that I can reconstruct an operational sequence without relying on memory.
2. As an operator, I want Tracegarden to preserve durable facts, so that a later investigation is not limited to the Cluster's current state.
3. As an operator, I want the product to distinguish correlation from causation, so that temporal proximity does not become an unsupported conclusion.
4. As an owner, I want to connect one Cluster, so that Tracegarden can observe my initial Kubernetes environment.
5. As an owner, I want to approve the namespaces Tracegarden may observe, so that collection remains within an explicit scope.
6. As an owner, I want unsupported namespaces to remain unread, so that enabling Tracegarden does not silently broaden access.
7. As an operator, I want Deployment changes normalized into Observations, so that rollout activity appears in the Timeline.
8. As an operator, I want StatefulSet changes normalized into Observations, so that stateful workload changes can be reconstructed.
9. As an operator, I want DaemonSet changes normalized into Observations, so that node-wide workload changes can be reconstructed.
10. As an operator, I want ReplicaSet changes normalized into Observations, so that rollout mechanics can be related to their parent workloads.
11. As an operator, I want Pod changes normalized into Observations, so that workload symptoms and recoveries are visible.
12. As an operator, I want Job and CronJob changes normalized into Observations, so that scheduled and one-shot work is represented.
13. As an operator, I want Kubernetes Events normalized into Observations, so that relevant control-plane messages remain available after they expire upstream.
14. As an operator, I want abnormal conditions classified as Attention Items, so that I can focus review without the product declaring an incident.
15. As an operator, I want recoveries represented in the Timeline, so that the sequence does not stop at the failure symptom.
16. As an operator, I want new Timeline Entries to appear within five seconds under normal conditions, so that the Timeline remains useful during active work.
17. As an operator, I want live updates to recover after a browser disconnect, so that reconnecting does not lose durable entries.
18. As an operator, I want duplicate delivery to remain invisible, so that reconnects do not create repeated Observations.
19. As an operator, I want Timeline pagination to use a stable cursor, so that new entries do not corrupt navigation through history.
20. As an operator, I want to filter the Timeline, so that I can narrow an investigation to relevant workloads, entry types, or states.
21. As a Member, I want unread Attention Items identified, so that I can distinguish new review work from items already seen.
22. As an operator, I want to create an Experiment with a hypothesis, so that the reason for a change remains explicit.
23. As an operator, I want to record the change made during an Experiment, so that later readers know what was attempted.
24. As an operator, I want to record observations and a conclusion separately, so that evidence remains distinguishable from judgment.
25. As an operator, I want an Experiment to have a lifecycle state, so that in-progress and concluded work can be distinguished.
26. As an operator, I want to tag an Experiment, so that related operational work can be found later.
27. As an operator, I want to associate an Experiment with workloads, so that its operational scope is explicit.
28. As an operator, I want to attach an optional Git revision to an Experiment, so that a code state can be recorded when relevant.
29. As an operator, I want Markdown within structured Experiment fields, so that I can express useful detail without losing the journal structure.
30. As an operator, I want to update an Experiment as work progresses, so that the durable record reflects the completed investigation.
31. As an operator, I want Correlation Suggestions between changes, symptoms, and Experiments, so that plausible relationships are easier to review.
32. As an operator, I want each Correlation Suggestion to remain pending human judgment, so that the system does not assert a cause.
33. As an operator, I want to confirm a Correlation Suggestion, so that accepted relationships become durable Confirmed Links.
34. As an operator, I want to reject a Correlation Suggestion, so that misleading relationships stop distracting future review.
35. As an operator, I want Confirmed Links to identify the Member who accepted them, so that human judgment has an accountable source.
36. As an operator, I want to revisit persisted history later, so that I can reconstruct the relevant sequence after the immediate event.
37. As a prospective Member, I want Google OAuth to prove my identity, so that I do not need a separate Tracegarden password.
38. As an owner, I want Google login alone to be insufficient for admission, so that only invited identities become Members.
39. As an owner, I want to create and revoke an Invitation for one email address, so that Workspace admission remains controlled.
40. As the first configured identity, I want to become the owner, so that the Workspace has an initial administrator.
41. As an owner, I want to assign owner, operator, or viewer roles, so that Members receive an appropriate capability set.
42. As a Member, I want authorization enforced through Capabilities, so that handlers do not infer sensitive access from scattered role-name checks.
43. As a viewer, I want read-only access to permitted history, so that I can investigate without modifying operational records.
44. As an owner, I want membership and sensitive log-access actions audited, so that privileged actions are reviewable.
45. As an owner, I want to request recent logs for one Pod and container, so that I can inspect a bounded symptom without deploying a log store.
46. As an owner, I want each recent log response limited to 200 lines or 1 MiB, so that the request cannot become an unbounded data path.
47. As a Member without the log-reading Capability, I want log requests denied, so that ordinary observation access does not expose container output.
48. As an owner, I want recent log bodies excluded from persistence, caches, telemetry, analytics, and exception messages, so that Tracegarden does not become a container log repository.
49. As a Cluster administrator, I want observation and log access to use separate Kubernetes identities, so that the collector cannot inherit log access.
50. As a Cluster administrator, I want the collector limited to get, list, and watch on approved kinds, so that Tracegarden cannot mutate workloads.
51. As a Cluster administrator, I want Secrets, ConfigMap values, exec, and port-forward outside Tracegarden's permissions, so that observation does not expose unrelated sensitive data or interactive access.
52. As an owner, I want ordinary Observation retention to default to 90 days and remain configurable, so that storage use is bounded.
53. As an operator, I want Experiments and entries in Confirmed Links retained independently of ordinary Observation cleanup, so that important human context is not removed by routine retention.
54. As an owner, I want retention cleanup to be idempotent and observable without logging deleted payloads, so that cleanup can be retried safely.
55. As a Chinese-speaking Member, I want Simplified Chinese as the default interface language, so that the initial experience matches my preference.
56. As an English-speaking Member, I want to switch the interface to English, so that the same Workspace supports both languages.
57. As an operator, I want startup, readiness, and conservative liveness endpoints, so that deployment automation can distinguish process states safely.
58. As an operator, I want metrics for collector lag, reconnects, relists, normalization failures, persistence failures, SSE clients, cursor lag, database pools, and migrations, so that I can diagnose Tracegarden itself.
59. As an operator, I want missing telemetry exporters to leave core behavior available, so that observability remains best-effort rather than a runtime dependency.
60. As a maintainer, I want the web and collector to run as separate processes within one product, so that long-lived observation failures do not share the web request lifecycle.
61. As a maintainer, I want database migrations to complete before rollout, so that incompatible application code never starts against an old schema.
62. As a maintainer, I want both production images to run as non-root, so that container privileges are minimized.
63. As a maintainer, I want required CI checks to validate installation, formatting, types, tests, builds, containers, manifests, and supply-chain policy, so that changes have repeatable evidence before merge.
64. As a reviewer, I want every non-draft pull request to receive an isolated Preview Environment when capacity permits, so that application and deployment behavior can be reviewed safely.
65. As an operator, I want preview capacity exhaustion to fail only that preview, so that production reservations are protected.
66. As a security-conscious owner, I want Preview Environment identity validated from the configured Cloudflare Access JWT issuer and audience, so that arbitrary proxy headers cannot grant admission.
67. As a maintainer, I want Preview Environments removed when pull requests close or become drafts, so that disposable resources do not accumulate.
68. As a maintainer, I want GitHub Actions to publish immutable images without a cluster-admin kubeconfig, so that CI cannot directly control the Cluster.
69. As an operator, I want Argo CD to pull approved desired state, so that production promotion remains reviewable through Git.
70. As an owner, I want encrypted off-VM backup templates disabled until their storage, encryption, retention, and credentials are explicitly configured, so that an incomplete backup path is not mistaken for protection.
71. As an owner, I want a restore rehearsal to prove a backup usable, so that the existence of a dump is not treated as disaster recovery.
72. As a maintainer, I want unverified external integration values to remain configuration or placeholders, so that local implementation does not guess production facts.

## Implementation Decisions

- Tracegarden is one product in a monorepo with independently deployed web and collector processes. The process boundary reflects different lifecycles; it does not create independently versioned microservices.
- The implementation uses Node.js 26.8.x with ESM and TypeScript 7 under explicit strict settings. TypeScript 7's native `tsc` is the authoritative compiler; compatibility with tooling that historically consumed the programmatic compiler API must be proven during the foundation phase rather than silently falling back to a legacy compiler. The owner accepts the Current-runtime risk recorded in the architecture decisions.
- The web application uses TanStack Start, React, TanStack Router, TanStack Query, Tailwind CSS, and accessible headless primitives. TanStack Start's Release Candidate status is an accepted, documented upgrade risk.
- Typed application transport uses tRPC 11 with Zod 4.5 runtime validation. Static TypeScript inference never replaces validation at an external boundary.
- PostgreSQL 18 is the durable authority. Drizzle ORM stays on the stable 0.45 line rather than the prerelease v1 line.
- Exact dependency patches are selected and pinned only after the full framework combination installs, compiles, builds, and runs together on Node.js 26.
- Cluster observation accepts a Cluster identity and approved namespace/resource scope and emits ordered, normalized Observations. Callers never handle Kubernetes list/watch protocol details.
- Cluster observation begins with a list, resumes watches from persisted `resourceVersion` checkpoints, uses finite bounded backoff, and performs a fresh list after `410 Gone`.
- The production observation adapter uses the Kubernetes client library. Automated tests use a deterministic stream adapter capable of controlling list results, watch delivery, disconnections, bookmarks, relists, and failures without sleeps.
- Supported inputs are Deployment, StatefulSet, DaemonSet, ReplicaSet, Pod, Job, CronJob, and Kubernetes Event data. Projection stores normalized facts, not complete raw Kubernetes objects.
- Cluster-derived resource identity combines Kubernetes UID with Cluster identity. Watch replay is protected by a uniqueness constraint so that duplicate delivery cannot create duplicate Observations.
- Observation normalization and Timeline persistence occur through an idempotent PostgreSQL transaction. An Observation becomes publishable only after commit.
- The Timeline module owns recording Observations and Experiments, cursor pagination, filtering, Attention Item state, Correlation Suggestions, Confirmed Links, and the rule that a suggestion is not a cause.
- The Experiment journal owns the structured hypothesis, change, observation, and conclusion lifecycle, including state, tags, optional Git revision, and workload associations. Markdown is permitted within fields but cannot replace the structure.
- Correlation Suggestions may use time, ownership, labels, or revision as candidate signals. They remain suggestions until a Member confirms them; rejection is also recorded as explicit human judgment.
- Every business record carries a Workspace identity, and Cluster-related records carry a Cluster identity, even though the initial UI exposes one Workspace and one Cluster connection.
- Better Auth proves Google identity and owns the session. Tracegarden owns Invitations, Memberships, roles, and Capability grants.
- Google issuer and subject form the durable external identity. Email is used for display and Invitation matching but is not the permanent identity key.
- The first configured identity becomes owner. Subsequent Google identities require a valid Invitation before becoming Members. The MVP does not send invitation emails.
- Initial roles are owner, operator, and viewer, but application handlers authorize named Capabilities rather than checking role names directly.
- Production uses Google OAuth. Automated tests use a local identity adapter. Preview Environments accept identity only after validating the configured Cloudflare Access JWT issuer and audience.
- Live Timeline delivery treats PostgreSQL as authoritative. A committed transaction emits a PostgreSQL notification containing only an entry ID or cursor; the web process converts it to an SSE hint, and clients query missing rows through tRPC.
- SSE reconnects, missed notifications, and duplicate notifications are harmless because clients recover from a durable cursor rather than treating the event stream as storage.
- Recent Log Window is a separate module accepting an authorized Cluster, namespace, Pod, container, and bounded tail request. The response is capped at 200 lines or 1 MiB.
- Recent Log Window uses a Kubernetes identity separate from the collector and requires the owner-only `logs:read` Capability. It never persists, indexes, caches, or emits the log body through telemetry, analytics, or exception messages.
- Kubernetes authorization prefers namespace-scoped Roles. The collector receives only get, list, and watch for approved resource kinds and receives no Secret, ConfigMap-value, log, exec, port-forward, or write access.
- Future Kubernetes actions require a new Capability, audited command model, executor module, and third Kubernetes identity. Neither the collector nor log identity may be expanded into a writer.
- The initial schema covers Workspace, Member, external identity, session, Invitation, role, Capability grant, Cluster scope, normalized resource identity, latest snapshot, Observation, Timeline Entry, Attention Item state, ingestion cursor, Experiment, workload association, Correlation Suggestion, Confirmed Link, retention policy, and immutable audit records for membership and log-access actions.
- Ordinary Observations default to 90-day retention. Experiments and Timeline Entries participating in Confirmed Links survive ordinary cleanup until explicitly deleted. Cleanup is scheduled, idempotent, and reports counts without deleted payloads.
- Simplified Chinese is the default interface language. Equivalent English message catalogs are included, and user-visible domain concepts remain consistent across languages.
- OpenTelemetry traces, metrics, and structured logs use optional exporters. Exporter failure is best-effort and cannot block ingestion or web requests.
- Operational endpoints and metrics cover startup, readiness, conservative liveness, collector behavior, SSE state, database pools, and migration status.
- Production images for web and collector run as non-root. Deployment configuration includes separate Deployments, Services, Ingress, NetworkPolicies, ServiceAccounts, scoped RBAC, resource limits, probes, PostgreSQL storage, and a one-shot migration Job.
- A required migration failure blocks rollout. Application processes do not start against an unverified schema state.
- CI performs a frozen workspace install, formatting and lint checks, TypeScript checks, domain and deterministic collector tests, PostgreSQL integration tests, web build, browser smoke tests, non-root container checks, manifest rendering and schema validation, and selected dependency, image, secret-pattern, and supply-chain checks.
- CI permissions are explicitly least-privilege, third-party actions are pinned to immutable revisions, application images use commit-SHA tags and immutable digests, and release builds produce an SBOM and provenance attestation.
- Every eligible non-draft pull request receives an isolated Preview Environment with its own namespace, application instances, temporary PostgreSQL database, and seeded non-production data. Preview capacity limits protect production, and lifecycle reconciliation removes orphaned previews.
- Pull-based GitOps is the deployment model. GitHub Actions builds immutable images; Argo CD reads the private GitOps repository and applies reviewed desired state. CI never receives a cluster-admin kubeconfig.
- Production promotion starts from a version tag or release, rebuilds and verifies the selected commit, records immutable image digests, requires protected-environment approval, and proposes a reviewed GitOps digest update.
- The encrypted PostgreSQL backup CronJob remains disabled until off-VM storage, endpoint, encryption, credentials, schedule, and retention are explicitly configured. A backup is not accepted until restore into a clean database passes integrity checks.
- Live operations against a Kubernetes context, cloud account, GitHub account, or credential source require separate explicit authorization. Existing company Kubernetes contexts are outside scope and must not be contacted.

## Testing Decisions

- A good test exercises observable behavior through the highest stable module or user boundary. Tests do not mirror internal mappings, private control flow, or framework wiring. Each test protects a distinct behavior partition and uses deterministic coordination rather than timing sleeps.
- The primary acceptance seam is one Playwright core-loop scenario backed by the local identity adapter, deterministic Kubernetes input, and a real disposable PostgreSQL database. It covers admitted login, Timeline browsing, live Observation delivery, Experiment creation and update, Correlation Suggestion review, confirm/reject behavior, and reconstruction from persisted history.
- The same browser boundary covers rejected login, Capability-visible UI behavior, Simplified Chinese default rendering, English switching, cursor pagination, filtering, unread Attention Items, and reconnect recovery where these behaviors can be driven reliably.
- Cluster observation is tested through its public module interface with the deterministic stream adapter. Partitions include initial list synchronization, ordered delivery, duplicate delivery, disconnection, bounded reconnect, missing bookmarks, resume checkpoints, `410 Gone` relist, normalization failure, and persistence failure.
- Timeline and Experiment behavior is tested through domain interfaces. Tests cover idempotent recording, stable cursor ordering, Attention Item state, Experiment lifecycle invariants, Correlation Suggestion semantics, rejection, Confirmed Link creation, and the prohibition on presenting suggestions as cause.
- Identity and membership tests use the local identity adapter and exercise the observable admission contract: first-owner bootstrap, valid Invitation matching, revoked or absent Invitation rejection, durable external identity, role assignment, and Capability authorization.
- tRPC tests exercise runtime validation and authorization at the transport boundary, including attempts to call owner-only membership, retention, and log operations without the required Capability.
- Repository integration tests apply migrations and execute real queries against a disposable PostgreSQL instance. They cover uniqueness under duplicate watch delivery, transactional Observation and Timeline persistence, cursor queries, retention eligibility, audit immutability, and migration ordering.
- Live Timeline tests treat database rows as authoritative and notifications as hints. They cover commit-before-notify, missed or duplicate notifications, SSE reconnect, and cursor recovery without asserting private PostgreSQL listener implementation details.
- Recent Log Window tests use a fake Kubernetes log adapter and its public module boundary. They cover authorization, Cluster/namespace/Pod/container validation, the 200-line limit, the 1 MiB limit, non-persistence, non-caching, audit metadata, and exclusion of bodies from logs, traces, metrics, analytics, and exception text.
- Retention tests use controlled time and real repository behavior. They cover the 90-day default, owner configuration, idempotent retries, preservation of Experiments and Confirmed Link participants, and payload-free deletion reporting.
- Container smoke tests run the production images as non-root and exercise startup, readiness, conservative liveness, graceful shutdown, required configuration validation, and migration failure behavior.
- Deployment tests render the Helm chart and validate Kubernetes schemas without contacting a Cluster. They inspect scoped RBAC, separate ServiceAccounts, NetworkPolicies, resource bounds, probes, migration ordering, immutable image references, disabled backup defaults, and Preview Environment isolation.
- CI and delivery configuration tests lint workflow syntax and verify explicit permissions, immutable third-party action references, absence of cluster credentials, digest-based promotion inputs, and required preview cleanup declarations.
- Existing prior art is architectural rather than executable because the repository currently contains design documents and no application test suite. The established patterns are the documented domain-interface tests, deterministic collector adapter, real disposable PostgreSQL integration boundary, Playwright core-loop test, non-root container smoke tests, and offline manifest validation. Implementation should establish these seams directly rather than invent lower-level alternatives.
- Live Kubernetes compatibility, real Google OAuth callbacks, Cloudflare Access, Argo CD reconciliation, GHCR publication, backup upload, and restore are not claimed by local tests. They remain explicitly unverified until authorized environments are supplied.

## Out of Scope

- Replacing Grafana, Prometheus, Alertmanager, Loki, or a full Kubernetes dashboard.
- Persisting, indexing, searching, caching, or analyzing container logs.
- Reading Kubernetes Secrets, ConfigMap values, environment variable values, or complete raw Kubernetes objects.
- Restarting, scaling, rolling back, patching, deleting, executing within, or port-forwarding to workloads.
- Automatically declaring root cause or converting a Correlation Suggestion into a Confirmed Link without Member judgment.
- Multiple Workspaces or multiple Cluster connections in the initial UI, despite retaining their identities in persisted data.
- Email delivery for Invitations.
- Email, webhook, paging, or alert delivery.
- Automatic ingestion from GitHub, GitLab, Cloudflare, or other non-Kubernetes observation sources.
- A bundled complete monitoring stack.
- Automatic production cloud, repository, Cluster, DNS, OAuth, Cloudflare, R2, or Argo CD setup.
- Contacting or modifying any existing company Kubernetes context or other company resource.
- Enabling the backup CronJob before its full security and restore contract is configured and proven.
- Treating Preview Environments as production or mounting production data or credentials into them.

## Further Notes

- The repository is currently in the design phase. No application implementation, dependency lockfile, remote repository, production credential, cloud resource, or authorized personal Cluster context exists yet.
- Local implementation is observably complete only when the deterministic core loop runs against real disposable PostgreSQL, the bilingual browser smoke tests pass, both production images build and run as non-root, and deployment manifests render and validate offline.
- Node.js 26 and TanStack Start are deliberate risk acceptances. TypeScript 7 is the selected compiler, but compatibility with the chosen linting and framework toolchain remains unverified because version 7.0 does not expose a programmatic compiler API. Exact versions and adapter compatibility remain unverified until the foundation phase produces install, compile, build, and container evidence.
- The planned monorepo is still a single domain context. Shared modules should preserve the named deep boundaries rather than becoming a collection of transport-aware helpers.
- Persisted Workspace and Cluster identities, adapter boundaries, and separate Kubernetes identities are future-compatible seams. They do not authorize multi-Workspace UI, multiple active Cluster connections, or Kubernetes writes in this MVP.
- External production verification requires explicit authorization and primary evidence for the personal Cluster, ingress, storage, Argo CD, Cloudflare, Google OAuth, GitHub identity, GHCR, R2, and restore environment.
