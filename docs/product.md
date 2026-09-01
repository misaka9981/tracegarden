# Product

## Problem

Kubernetes dashboards show current state and monitoring systems show metrics, but neither reliably preserves the human context around a change: what was attempted, which workload changed, what symptoms followed, and what conclusion was reached. Tracegarden connects those facts in a durable timeline without pretending that temporal proximity proves causality.

## Users and access

The first deployment primarily serves its owner, but the product supports multiple members in one shared workspace.

- Members authenticate with Google OAuth.
- The first configured identity becomes `owner`.
- An owner admits another member by adding an email invitation in the application. No invitation email is sent in the MVP.
- Google OAuth success alone never grants access.
- Initial roles are `owner`, `operator`, and `viewer`; authorization is enforced through capabilities.
- The MVP exposes no Kubernetes write capability to any role.

## Core loop

The MVP is successful when a member can:

1. Connect one Kubernetes cluster and select namespaces to observe.
2. See workload changes, abnormal conditions, Kubernetes Events, and recoveries appear on a live timeline within five seconds under normal conditions.
3. Create an Experiment with a hypothesis, change, observation, conclusion, state, tags, optional Git revision, and associated workload.
4. Review Correlation Suggestions between changes, symptoms, and Experiments.
5. Confirm or reject a suggestion without the product presenting an unconfirmed relationship as a cause.
6. Return later and reconstruct the relevant sequence from persisted history.

## MVP capabilities

- Observe an allowlist of namespaces.
- Normalize Deployment, StatefulSet, DaemonSet, ReplicaSet, Pod, Job, CronJob, and Kubernetes Event data.
- Show a cursor-paginated timeline with filters, unread Attention Items, and live updates.
- Create and update structured Experiments.
- Suggest and confirm relationships between Timeline Entries.
- Switch between Simplified Chinese and English; Simplified Chinese is the default.
- Let an owner request a bounded recent log window for one Pod/container.
- Manage member invitations and role assignments.
- Configure ordinary Observation retention, defaulting to 90 days.

## Explicit non-goals

- Replacing Grafana, Prometheus, Alertmanager, Loki, or a full Kubernetes dashboard.
- Persisting or indexing container logs.
- Reading Secrets, ConfigMap values, environment variables, or complete raw Kubernetes objects.
- Restarting, scaling, rolling back, patching, or deleting workloads.
- Automatically declaring root cause.
- Supporting multiple workspaces or multiple cluster connections in the initial UI.
- Sending email, webhook, or paging alerts.
- Automatically ingesting GitHub, GitLab, or Cloudflare events in the MVP.

## Future-compatible seams

Persisted data carries `workspaceId` and `clusterId`, although the first UI exposes one of each. Future Kubernetes writes require a new capability, executor, audit path, and Kubernetes identity; they must not broaden the collector's reader identity. Git and Cloudflare integrations will enter as new observation adapters rather than changing the timeline model.
