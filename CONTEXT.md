# Tracegarden

Tracegarden gives operators a durable account of changes, symptoms, and experiments around Kubernetes workloads so they can reconstruct what happened without confusing correlation with causation.

## Language

**Workspace**:
The shared Tracegarden space whose members observe the same clusters, timeline, and experiments. The first release has one workspace even though persisted records retain workspace identity.
_Avoid_: Tenant, account, project

**Member**:
A Google identity admitted to a Workspace and granted capabilities through a role.
_Avoid_: Account, login, user record

**Invitation**:
A revocable admission for one email address to become a Member after a successful Google login.
_Avoid_: Allowlist entry, invite email

**Cluster**:
A Kubernetes control plane observed by Tracegarden under an explicitly approved namespace and resource scope.
_Avoid_: Environment, server

**Observation**:
A normalized, durable fact derived from Kubernetes resource state or a Kubernetes Event.
_Avoid_: Raw object, log, incident

**Timeline Entry**:
A chronologically ordered item visible to a Member, backed by either an Observation or an Experiment.
_Avoid_: Event

**Attention Item**:
A Timeline Entry classified as needing review but not necessarily proving a failure.
_Avoid_: Incident, root cause, alert

**Experiment**:
A structured record of a hypothesis, change, observation, and conclusion, optionally associated with workloads and a Git revision.
_Avoid_: Note, ticket

**Correlation Suggestion**:
A system-proposed relationship between entries based on time, ownership, labels, or revision, awaiting human judgment.
_Avoid_: Cause, incident link

**Confirmed Link**:
A relationship between entries explicitly accepted by a Member.
_Avoid_: Automatic correlation, root cause

**Capability**:
A named permission to perform one application action. Roles grant capabilities; handlers do not infer authorization directly from role names.
_Avoid_: Role check, Kubernetes permission

**Preview Environment**:
An isolated, disposable deployment created for one non-draft pull request and removed after that pull request closes.
_Avoid_: Staging, test namespace
