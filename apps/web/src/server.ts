import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { getRequestListener, type HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { state, type StatusResponse } from "../../../packages/contracts/src/index.js";
import {
  createDatabase,
  waitForDatabase,
  MemoryAdmissionStore,
  parseTimelineQuery,
  TimelineQueryValidationError,
  type DatabaseBoundary,
  type TimelineNotification,
  type TimelineNotificationSource,
  type ExperimentStore,
  type ObservationTimelineEntry,
  type TimelineEntry,
  type TimelinePage,
  CorrelationDecisionConflictError,
  type TimelineQuery,
  type TimelineStore,
} from "../../../packages/db/src/index.js";
import {
  configureClusterScope,
  hasClusterConfigureCapability,
  MemoryClusterScopeStore,
  ClusterScopeValidationError,
  SUPPORTED_RESOURCE_KINDS,
  type ClusterScope,
  type ClusterScopeStore,
} from "../../../packages/cluster/src/index.js";
import {
  capabilities,
  cloudflareAccessIdentity,
  configuredBootstrapIdentity,
  configuredCloudflareAccess,
  createIdentityAdapter,
  GOOGLE_ISSUER,
  hasCapability,
  isRole,
  LastWorkspaceOwnerError,
  requireCapability,
  type AdmissionStore,
  type AuthenticatedSession,
  type InvitationRecord,
  type LogAuditStore,
  type MemberRecord,
  type MembershipStore,
  type Role,
  type BetterAuthRuntime,
  type ExternalIdentity,
  type IdentityAdapter,
} from "../../../packages/identity/src/index.js";
import { messagesFor, parseLanguage, type Language, type Messages } from "../../../packages/i18n/src/index.js";
import {
  hasExperimentWrite,
  ExperimentLifecycleError,
  ExperimentValidationError,
  confirmCorrelationSuggestion,
  rejectCorrelationSuggestion,
  hasCorrelationReview,
  hasRetentionManagement,
  runRetentionCleanup,
  updateRetentionPolicy,
  RetentionValidationError,
  type ConfirmedLinkRecord,
  type CorrelationSuggestionRecord,
  type ExperimentRecord,
  type RetentionCleanupResult,
  type RetentionPolicy,
  type RetentionStore,
} from "../../../packages/domain/src/index.js";
import {
  createKubernetesLogAdapter,
  hasLogReadCapability,
  requestRecentLogWindow,
  RecentLogWindowValidationError,
  type KubernetesLogAdapter,
  type RecentLogTelemetryEvent,
  type RecentLogWindow,
} from "../../../packages/logs/src/index.js";
import { createTelemetry, type CorrelationMetadata, type TelemetryRuntime, type TelemetrySpan } from "../../../packages/telemetry/src/index.js";

type WebOptions = Readonly<{
  database?: DatabaseBoundary;
  admissionStore?: AdmissionStore;
  clusterScopeStore?: ClusterScopeStore;
  timelineStore?: TimelineStore;
  experimentStore?: ExperimentStore;
  retentionStore?: RetentionStore;
  identityAdapter?: IdentityAdapter;
  logAdapter?: KubernetesLogAdapter;
  environment?: Record<string, string | undefined>;
  port?: number;
  host?: string;
  telemetry?: TelemetryRuntime;
}>;

export type WebRuntime = Readonly<{
  server: Server;
  status: () => Promise<StatusResponse>;
  telemetry: TelemetryRuntime;
  close: () => Promise<void>;
}>;

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function renderCheck(label: string, ready: boolean, messages: Messages): string {
  const value = ready ? messages.ready : messages.notReady;
  const className = ready ? "ready" : "not-ready";
  return `<li><span>${escapeHtml(label)}</span><strong class="${className}">${escapeHtml(value)}</strong></li>`;
}

function renderLanguageLinks(language: Language, messages: Messages, path = "/"): string {
  const separator = path.includes("?") ? "&" : "?";
  return `<nav aria-label="${escapeHtml(messages.language)}">
        <a href="${path}${separator}lang=zh-CN" lang="zh-CN">${escapeHtml(messages.chinese)}</a>
        <a href="${path}${separator}lang=en" lang="en">${escapeHtml(messages.english)}</a>
      </nav>`;
}

function pageStyles(): string {
  return `<style>
      :root { color-scheme: light; font-family: system-ui, sans-serif; background: #f6f7f9; color: #1f2937; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
      main { width: min(42rem, calc(100% - 2rem)); background: white; border: 1px solid #d9dee8; border-radius: 1rem; padding: 2rem; box-shadow: 0 0.5rem 2rem #1f29371a; }
      h1 { margin-top: 0; }
      p { line-height: 1.6; }
      ul { display: grid; gap: 0.75rem; list-style: none; margin: 1.5rem 0; padding: 0; }
      li { display: flex; justify-content: space-between; border-bottom: 1px solid #edf0f5; padding: 0.75rem 0; }
      .ready { color: #087f5b; }
      .not-ready { color: #b42318; }
      nav { display: flex; gap: 1rem; margin-top: 1rem; }
      nav a { color: #175cd3; }
      .hint { color: #667085; font-size: 0.9rem; }
      form { display: grid; gap: 0.75rem; margin-top: 1.5rem; }
      label { font-weight: 600; }
      select, button { font: inherit; padding: 0.6rem 0.75rem; border: 1px solid #98a2b3; border-radius: 0.4rem; }
      button { background: #175cd3; border-color: #175cd3; color: white; cursor: pointer; }
      .error { color: #b42318; font-weight: 600; }
      .notice { color: #087f5b; font-weight: 600; }
      table { width: 100%; border-collapse: collapse; margin: 1rem 0 1.5rem; }
      th, td { text-align: left; border-bottom: 1px solid #edf0f5; padding: 0.75rem 0.5rem; vertical-align: top; }
      input { font: inherit; padding: 0.6rem 0.75rem; border: 1px solid #98a2b3; border-radius: 0.4rem; }
      .capabilities { display: flex; flex-wrap: wrap; gap: 0.5rem; padding: 0; list-style: none; }
      .capabilities li { border: 1px solid #d9dee8; border-radius: 999px; padding: 0.4rem 0.7rem; }
      pre { background: #101828; color: #f8fafc; border-radius: 0.5rem; padding: 1rem; overflow: auto; white-space: pre-wrap; }
    </style>`;
}

export function renderStatusPage(language: Language, databaseReady: boolean): string {
  const messages = messagesFor(language);
  return `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(messages.appName)} · ${escapeHtml(messages.statusTitle)}</title>
    ${pageStyles()}
  </head>
  <body>
    <main>
      <p class="hint">${escapeHtml(messages.appName)}</p>
      <h1>${escapeHtml(messages.statusTitle)}</h1>
      <p>${escapeHtml(messages.statusDescription)}</p>
      <ul>
        ${renderCheck(messages.webProcess, true, messages)}
        ${renderCheck(messages.database, databaseReady, messages)}
      </ul>
      <p class="hint">${escapeHtml(messages.noConfiguration)}</p>
      ${renderLanguageLinks(language, messages)}
    </main>
  </body>
</html>`;
}

function renderLocalOptions(adapter: IdentityAdapter, selected: string | undefined): string {
  return adapter.options.map((option) => `<option value="${escapeHtml(option.key)}"${option.key === selected ? " selected" : ""}>${escapeHtml(option.displayName)} · ${escapeHtml(option.email)}</option>`).join("");
}

export function renderLoginPage(language: Language, databaseReady: boolean, adapter: IdentityAdapter, error?: string, selected?: string): string {
  const messages = messagesFor(language);
  const authentication = adapter.kind === "local"
    ? `<form method="post" action="/auth/login">
          <input type="hidden" name="lang" value="${language}">
          <label for="identity">${escapeHtml(messages.localIdentity)}</label>
          <select id="identity" name="identity">${renderLocalOptions(adapter, selected)}</select>
          <button type="submit">${escapeHtml(messages.signIn)}</button>
        </form>`
    : `<p><a href="/auth/google?lang=${language}">${escapeHtml(messages.googleSignIn)}</a></p>`;
  return `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(messages.appName)} · ${escapeHtml(messages.statusTitle)}</title>
    ${pageStyles()}
  </head>
  <body>
    <main>
      <p class="hint">${escapeHtml(messages.appName)}</p>
      <h1>${escapeHtml(messages.statusTitle)}</h1>
      <p>${escapeHtml(messages.statusDescription)}</p>
      <ul>
        ${renderCheck(messages.webProcess, true, messages)}
        ${renderCheck(messages.database, databaseReady, messages)}
      </ul>
      <h2>${escapeHtml(messages.loginTitle)}</h2>
      <p>${escapeHtml(messages.loginDescription)}</p>
      ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
      ${authentication}
      <p class="hint">${escapeHtml(messages.noConfiguration)}</p>
      ${renderLanguageLinks(language, messages)}
    </main>
  </body>
</html>`;
}

function renderClusterSection(
  language: Language,
  messages: Messages,
  member: AuthenticatedSession["member"],
  scope: ClusterScope | null,
  feedback?: Readonly<{ saved?: boolean; error?: string }>,
): string {
  const namespaces = scope?.namespaces.join("\n") ?? "";
  const selectedKinds = new Set(scope?.resourceKinds ?? []);
  const resourceKinds = SUPPORTED_RESOURCE_KINDS.map((kind) => `<label><input type="checkbox" name="resourceKinds" value="${escapeHtml(kind)}"${selectedKinds.has(kind) ? " checked" : ""}> ${escapeHtml(kind)}</label>`).join(" ");
  const summary = scope
    ? `<dl>
        <dt>${escapeHtml(messages.clusterName)}</dt><dd>${escapeHtml(scope.name)}</dd>
        <dt>${escapeHtml(messages.clusterEndpoint)}</dt><dd>${escapeHtml(scope.endpoint)}</dd>
        <dt>${escapeHtml(messages.approvedNamespaces)}</dt><dd>${escapeHtml(scope.namespaces.join(", ") || messages.clusterNotConfigured)}</dd>
        <dt>${escapeHtml(messages.approvedResourceKinds)}</dt><dd>${escapeHtml(scope.resourceKinds.join(", ") || messages.clusterNotConfigured)}</dd>
      </dl>`
    : `<p>${escapeHtml(messages.clusterNotConfigured)}</p>`;
  const form = hasClusterConfigureCapability(member)
    ? `<form method="post" action="/cluster/configure?lang=${language}">
        <input type="hidden" name="clusterId" value="${escapeHtml(scope?.clusterId ?? "")}">
        <label for="cluster-name">${escapeHtml(messages.clusterName)}</label>
        <input id="cluster-name" name="name" required maxlength="100" value="${escapeHtml(scope?.name ?? "")}">
        <label for="cluster-endpoint">${escapeHtml(messages.clusterEndpoint)}</label>
        <input id="cluster-endpoint" name="endpoint" type="url" required value="${escapeHtml(scope?.endpoint ?? "")}">
        <label for="cluster-namespaces">${escapeHtml(messages.approvedNamespaces)}</label>
        <textarea id="cluster-namespaces" name="namespaces" rows="4">${escapeHtml(namespaces)}</textarea>
        <fieldset>
          <legend>${escapeHtml(messages.approvedResourceKinds)}</legend>
          <p class="hint">${escapeHtml(messages.supportedResourceKinds)}</p>
          ${resourceKinds}
        </fieldset>
        <button type="submit">${escapeHtml(messages.saveCluster)}</button>
      </form>`
    : `<p class="error" role="alert">${escapeHtml(messages.clusterConfigurationDenied)}</p>`;
  return `<section aria-labelledby="cluster-scope-title">
      <h2 id="cluster-scope-title">${escapeHtml(messages.clusterTitle)}</h2>
      <p>${escapeHtml(messages.clusterDescription)}</p>
      ${feedback?.saved ? `<p role="status">${escapeHtml(messages.clusterSaved)}</p>` : ""}
      ${feedback?.error ? `<p class="error" role="alert">${escapeHtml(feedback.error)}</p>` : ""}
      ${summary}
      ${form}
    </section>`;
}

function resourceKindLabel(kind: ObservationTimelineEntry["observation"]["kind"], messages: Messages): string {
  if (kind === "Pod") return messages.podObservation;
  const labels: Record<ObservationTimelineEntry["observation"]["kind"], string> = {
    Deployment: messages.resourceKindDeployment,
    StatefulSet: messages.resourceKindStatefulSet,
    DaemonSet: messages.resourceKindDaemonSet,
    ReplicaSet: messages.resourceKindReplicaSet,
    Pod: messages.resourceKindPod,
    Job: messages.resourceKindJob,
    CronJob: messages.resourceKindCronJob,
    Event: messages.resourceKindEvent,
  };
  return labels[kind];
}

function observationStateLabel(entry: ObservationTimelineEntry, messages: Messages): string {
  if (entry.recoveryOf || entry.observation.classification === "recovery") return messages.recovery;
  if (entry.attentionItem || entry.observation.classification === "attention") return messages.attentionItem;
  return messages.observationChange;
}

function observationDetail(entry: ObservationTimelineEntry, messages: Messages): string {
  const observation = entry.observation;
  const recovery = observation.classification === "recovery" || entry.recoveryOf !== null;
  if (observation.kind === "Pod") return observation.phase ?? messages.timelineUnknownState;
  if (observation.kind === "Event") return observation.reason ?? observation.eventType ?? messages.timelineUnknownState;
  if (observation.kind === "Job") {
    if (recovery) return messages.recovery;
    if (entry.attentionItem || observation.classification === "attention") return messages.attentionItem;
    return observation.completionTime ?? messages.timelineUnknownState;
  }
  if (observation.kind === "CronJob") return observation.suspend ? messages.attentionItem : observation.schedule ?? messages.timelineUnknownState;
  return observation.revision ?? messages.timelineUnknownState;
}

function attentionReasonLabel(entry: ObservationTimelineEntry, messages: Messages): string {
  return entry.attentionReason ? messages.attentionReasonLabels[entry.attentionReason] ?? messages.timelineUnknownState : messages.timelineUnknownState;
}

function timelineQueryValue(query: TimelineQuery, field: "namespace" | "name" | "state"): string {
  return query[field] ?? "";
}

function timelineStateLabel(messages: Messages, state: string): string {
  return ({
    Pending: messages.timelineStatePending,
    Running: messages.timelineStateRunning,
    Succeeded: messages.timelineStateSucceeded,
    Failed: messages.timelineStateFailed,
    Unknown: messages.timelineStateUnknown,
  } as Readonly<Record<string, string>>)[state] ?? state;
}

function timelineNextPageUrl(language: Language, query: TimelineQuery, cursor: string): string {
  const params = new URLSearchParams({ lang: language, limit: String(query.limit), cursor });
  if (query.kind) params.set("kind", query.kind);
  if (query.namespace) params.set("namespace", query.namespace);
  if (query.name) params.set("name", query.name);
  if (query.state) params.set("state", query.state);
  if (query.attention !== undefined) params.set("attention", String(query.attention));
  if (query.unread !== undefined) params.set("unread", String(query.unread));
  return `/app?${params.toString()}`;
}

function experimentStateLabel(messages: Messages, state: ExperimentRecord["state"]): string {
  return state === "draft" ? messages.experimentDraft
    : state === "active" ? messages.experimentActive
      : state === "concluded" ? messages.experimentConcluded
        : messages.experimentAbandoned;
}

function workloadText(workload: ExperimentRecord["workloads"][number]): string {
  return `${workload.clusterId} | ${workload.namespace} | ${workload.kind} | ${workload.name}`;
}

function renderExperimentForm(
  language: Language,
  messages: Messages,
  experiment?: ExperimentRecord,
): string {
  const action = experiment ? `/experiments/${encodeURIComponent(experiment.id)}` : "/experiments";
  const workloads = experiment?.workloads.map(workloadText).join("\n") ?? "";
  const tags = experiment?.tags.join("\n") ?? "";
  return `<form method="post" action="${action}?lang=${language}"${experiment ? ` data-experiment-form="${escapeHtml(experiment.id)}"` : ""}>
      <input type="hidden" name="lang" value="${language}">
      ${experiment ? `<input type="hidden" name="experimentId" value="${escapeHtml(experiment.id)}">` : ""}
      <label for="experiment-hypothesis${experiment ? `-${escapeHtml(experiment.id)}` : ""}">${escapeHtml(messages.hypothesis)}</label>
      <textarea id="experiment-hypothesis${experiment ? `-${escapeHtml(experiment.id)}` : ""}" name="hypothesis" rows="3" required>${escapeHtml(experiment?.hypothesis ?? "")}</textarea>
      <label for="experiment-change${experiment ? `-${escapeHtml(experiment.id)}` : ""}">${escapeHtml(messages.change)}</label>
      <textarea id="experiment-change${experiment ? `-${escapeHtml(experiment.id)}` : ""}" name="change" rows="3" required>${escapeHtml(experiment?.change ?? "")}</textarea>
      <label for="experiment-observation${experiment ? `-${escapeHtml(experiment.id)}` : ""}">${escapeHtml(messages.observation)}</label>
      <textarea id="experiment-observation${experiment ? `-${escapeHtml(experiment.id)}` : ""}" name="observation" rows="3" required>${escapeHtml(experiment?.observation ?? "")}</textarea>
      <label for="experiment-conclusion${experiment ? `-${escapeHtml(experiment.id)}` : ""}">${escapeHtml(messages.conclusion)}</label>
      <textarea id="experiment-conclusion${experiment ? `-${escapeHtml(experiment.id)}` : ""}" name="conclusion" rows="3">${escapeHtml(experiment?.conclusion ?? "")}</textarea>
      <label for="experiment-state${experiment ? `-${escapeHtml(experiment.id)}` : ""}">${escapeHtml(messages.lifecycleState)}</label>
      <select id="experiment-state${experiment ? `-${escapeHtml(experiment.id)}` : ""}" name="state">
        ${(["draft", "active", "concluded", "abandoned"] as const).map((state) => `<option value="${state}"${state === (experiment?.state ?? "draft") ? " selected" : ""}>${escapeHtml(experimentStateLabel(messages, state))}</option>`).join("")}
      </select>
      <label for="experiment-tags${experiment ? `-${escapeHtml(experiment.id)}` : ""}">${escapeHtml(messages.tags)}</label>
      <textarea id="experiment-tags${experiment ? `-${escapeHtml(experiment.id)}` : ""}" name="tags" rows="2">${escapeHtml(tags)}</textarea>
      <label for="experiment-workloads${experiment ? `-${escapeHtml(experiment.id)}` : ""}">${escapeHtml(messages.workloads)}</label>
      <textarea id="experiment-workloads${experiment ? `-${escapeHtml(experiment.id)}` : ""}" name="workloads" rows="2" placeholder="${escapeHtml(messages.workloadFormat)}">${escapeHtml(workloads)}</textarea>
      <label for="experiment-git-revision${experiment ? `-${escapeHtml(experiment.id)}` : ""}">${escapeHtml(messages.gitRevision)}</label>
      <input id="experiment-git-revision${experiment ? `-${escapeHtml(experiment.id)}` : ""}" name="gitRevision" value="${escapeHtml(experiment?.gitRevision ?? "")}" autocomplete="off">
      <button type="submit">${escapeHtml(experiment ? messages.updateExperiment : messages.createExperiment)}</button>
    </form>`;
}

function renderExperimentSummary(messages: Messages, experiment: ExperimentRecord): string {
  return `<article data-experiment-id="${escapeHtml(experiment.id)}">
      <h3>${escapeHtml(messages.experimentsTitle)} · ${escapeHtml(experimentStateLabel(messages, experiment.state))}</h3>
      <dl>
        <dt>${escapeHtml(messages.hypothesis)}</dt><dd><pre>${escapeHtml(experiment.hypothesis)}</pre></dd>
        <dt>${escapeHtml(messages.change)}</dt><dd><pre>${escapeHtml(experiment.change)}</pre></dd>
        <dt>${escapeHtml(messages.observation)}</dt><dd><pre>${escapeHtml(experiment.observation)}</pre></dd>
        <dt>${escapeHtml(messages.conclusion)}</dt><dd><pre>${escapeHtml(experiment.conclusion)}</pre></dd>
        <dt>${escapeHtml(messages.tags)}</dt><dd>${escapeHtml(experiment.tags.join(", ") || "—")}</dd>
        <dt>${escapeHtml(messages.workloads)}</dt><dd>${escapeHtml(experiment.workloads.map(workloadText).join("; ") || "—")}</dd>
        <dt>${escapeHtml(messages.gitRevision)}</dt><dd>${escapeHtml(experiment.gitRevision ?? "—")}</dd>
      </dl>
      ${confirmedLinkDetails(messages, experiment.confirmedLinks)}
    </article>`;
}

function confirmedLinkDetails(messages: Messages, links: readonly ConfirmedLinkRecord[] | undefined): string {
  if (!links || links.length === 0) return "";
  const relationships = links.map((link) => `${link.leftEntryId} ↔ ${link.rightEntryId}`).join(", ");
  return `<p class="notice"><strong>${escapeHtml(messages.confirmedLink)}</strong>: ${escapeHtml(relationships)} · ${escapeHtml(messages.confirmedBy)}: ${escapeHtml(links.map((link) => link.confirmedByMemberId).join(", "))}</p>`;
}

function renderExperimentsSection(
  language: Language,
  messages: Messages,
  member: AuthenticatedSession["member"],
  experiments: readonly ExperimentRecord[],
  feedback?: Readonly<{ saved?: "created" | "updated"; error?: string }>,
): string {
  const writable = hasExperimentWrite(member);
  const forms = writable
    ? `<h3>${escapeHtml(messages.createExperiment)}</h3>${renderExperimentForm(language, messages)}`
    : `<p class="hint">${escapeHtml(messages.experimentWriteDenied)}</p>`;
  const updates = writable ? experiments.map((experiment) => `<details><summary>${escapeHtml(messages.updateExperiment)}: ${escapeHtml(experiment.id)}</summary>${renderExperimentForm(language, messages, experiment)}</details>`).join("") : "";
  return `<section aria-labelledby="experiments-title">
      <h2 id="experiments-title">${escapeHtml(messages.experimentsTitle)}</h2>
      <p>${escapeHtml(messages.experimentsDescription)}</p>
      ${feedback?.saved === "created" ? `<p class="notice" role="status">${escapeHtml(messages.experimentCreated)}</p>` : ""}
      ${feedback?.saved === "updated" ? `<p class="notice" role="status">${escapeHtml(messages.experimentUpdated)}</p>` : ""}
      ${feedback?.error ? `<p class="error" role="alert">${escapeHtml(feedback.error)}</p>` : ""}
      ${forms}
      ${experiments.map((experiment) => renderExperimentSummary(messages, experiment)).join("") || `<p>${escapeHtml(messages.noExperiments)}</p>`}
      ${updates}
    </section>`;
}

function renderCorrelationSection(
  language: Language,
  messages: Messages,
  member: AuthenticatedSession["member"],
  suggestions: readonly CorrelationSuggestionRecord[],
  entries: readonly TimelineEntry[],
  feedback?: Readonly<{ decision?: "confirmed" | "rejected"; error?: string }>,
): string {
  const labelFor = (id: string): string => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) return id;
    return entry.entryType === "experiment"
      ? `${messages.experimentsTitle}: ${entry.experiment.hypothesis}`
      : `${entry.observation.kind} ${entry.observation.namespace}/${entry.observation.name}`;
  };
  const rows = suggestions.map((suggestion) => `<article data-correlation-suggestion-id="${escapeHtml(suggestion.id)}">
      <h3>${escapeHtml(messages.correlationsTitle)}</h3>
      <p>${escapeHtml(labelFor(suggestion.leftEntryId))} ↔ ${escapeHtml(labelFor(suggestion.rightEntryId))}</p>
      <p><strong>${escapeHtml(messages.correlationSignals)}:</strong> ${escapeHtml(suggestion.signals.map((signal) => messages.correlationSignalLabels[signal] ?? signal).join(", "))}</p>
      ${hasCorrelationReview(member) ? `<form method="post" action="/correlations/suggestions/${encodeURIComponent(suggestion.id)}/confirm?lang=${language}"><button type="submit">${escapeHtml(messages.confirmSuggestion)}</button></form><form method="post" action="/correlations/suggestions/${encodeURIComponent(suggestion.id)}/reject?lang=${language}"><button type="submit">${escapeHtml(messages.rejectSuggestion)}</button></form>` : `<p class="hint">${escapeHtml(messages.correlationReviewDenied)}</p>`}
    </article>`).join("");
  return `<section aria-labelledby="correlations-title">
      <h2 id="correlations-title">${escapeHtml(messages.correlationsTitle)}</h2>
      <p>${escapeHtml(messages.correlationsDescription)}</p>
      ${feedback?.decision === "confirmed" ? `<p class="notice" role="status">${escapeHtml(messages.suggestionConfirmed)}</p>` : feedback?.decision === "rejected" ? `<p class="notice" role="status">${escapeHtml(messages.suggestionRejected)}</p>` : ""}
      ${feedback?.error ? `<p class="error" role="alert">${escapeHtml(feedback.error)}</p>` : ""}
      ${rows || `<p>${escapeHtml(messages.noCorrelationSuggestions)}</p>`}
    </section>`;
}

function renderTimelineSection(language: Language, messages: Messages, page: TimelinePage, query: TimelineQuery, reviewed = false): string {
  const rows = page.entries.map((entry) => {
    if (entry.entryType === "experiment") {
      return `<article data-entry-id="${escapeHtml(entry.id)}" data-entry-occurred-at="${escapeHtml(entry.occurredAt)}"><h3>${escapeHtml(messages.experimentsTitle)} · ${escapeHtml(experimentStateLabel(messages, entry.experiment.state))}</h3><p>${escapeHtml(entry.experiment.hypothesis)}</p><p>${escapeHtml(entry.occurredAt)}</p>${confirmedLinkDetails(messages, entry.confirmedLinks)}</article>`;
    }
    const observation = entry.observation;
    const owners = (observation.ownerReferences ?? []).map((owner) => `${owner.kind}/${owner.name}`).join(", ");
    const attention = entry.attentionItem
      ? `<p><strong>${escapeHtml(messages.attentionItem)}</strong> ${escapeHtml(attentionReasonLabel(entry, messages))} · ${entry.attentionUnread ? escapeHtml(messages.attentionUnread) : escapeHtml(messages.attentionReviewed)}</p>${entry.attentionUnread ? `<form method="post" action="/timeline/entries/${encodeURIComponent(entry.id)}/review?lang=${language}"><button type="submit">${escapeHtml(messages.reviewAttention)}</button></form>` : ""}`
      : "";
    return `<article data-entry-id="${escapeHtml(entry.id)}" data-entry-occurred-at="${escapeHtml(entry.occurredAt)}">
        <h3>${escapeHtml(resourceKindLabel(observation.kind, messages))} · ${escapeHtml(observationStateLabel(entry, messages))}</h3>
        <p>${escapeHtml(observation.namespace)}/${escapeHtml(observation.name)} · ${escapeHtml(observationDetail(entry, messages))}</p>
        ${attention}
        ${entry.recoveryOf || observation.classification === "recovery" ? `<p class="notice">${escapeHtml(messages.recovery)}</p>` : ""}
        ${confirmedLinkDetails(messages, entry.confirmedLinks)}
        <dl>
          <dt>${escapeHtml(messages.clusterName)}</dt><dd>${escapeHtml(entry.clusterId)}</dd>
          <dt>${escapeHtml(messages.resourceIdentity)}</dt><dd>${escapeHtml(observation.sourceIdentity)}</dd>
          <dt>${escapeHtml(messages.ownership)}</dt><dd>${escapeHtml(owners || messages.timelineUnknownState)}</dd>
          <dt>${escapeHtml(messages.revision)}</dt><dd>${escapeHtml(observation.revision ?? messages.timelineUnknownState)}</dd>
          <dt>${escapeHtml(messages.observedAt)}</dt><dd>${escapeHtml(entry.occurredAt)}</dd>
        </dl>
      </article>`;
  }).join("");
  const next = page.nextCursor ? `<p><a href="${escapeHtml(timelineNextPageUrl(language, query, page.nextCursor))}">${escapeHtml(messages.nextTimelinePage)}</a></p>` : "";
  const attentionFilter = query.unread ? "unread" : query.attention ? "attention" : "";
  const attentionLabel = page.entries.some((entry) => entry.entryType === "observation" && entry.attentionItem)
    ? messages.timelineAttention
    : messages.timelineAttention.replace(/ Item$/, "");
  const attentionOnlyLabel = page.entries.some((entry) => entry.entryType === "observation" && entry.attentionItem)
    ? messages.timelineAttentionOnly
    : messages.timelineAttentionOnly.replace(/ Items? only$/, " only");
  const unreadAttentionOnlyLabel = page.entries.some((entry) => entry.entryType === "observation" && entry.attentionItem)
    ? messages.timelineUnreadOnly
    : messages.timelineUnreadOnly.replace(/ Items? only$/, " only");
  const liveAttributes = [
    `data-live-timeline="true"`,
    `data-timeline-limit="${query.limit}"`,
    ...(query.kind ? [`data-timeline-kind="${escapeHtml(query.kind)}"`] : []),
    ...(query.namespace ? [`data-timeline-namespace="${escapeHtml(query.namespace)}"`] : []),
    ...(query.name ? [`data-timeline-name="${escapeHtml(query.name)}"`] : []),
    ...(query.state ? [`data-timeline-state="${escapeHtml(query.state)}"`] : []),
    ...(query.attention !== undefined ? [`data-timeline-attention="${query.attention}"`] : []),
    ...(query.unread !== undefined ? [`data-timeline-unread="${query.unread}"`] : []),
    ...(page.resumeCursor ? [`data-timeline-cursor="${escapeHtml(page.resumeCursor)}"`] : []),
  ].join(" ");
  return `<section aria-labelledby="timeline-title" ${liveAttributes}>
      <h2 id="timeline-title">${escapeHtml(messages.timelineTitle)}</h2>
      <p>${escapeHtml(messages.timelineDescription)}</p>
      ${reviewed ? `<p class="notice" role="status">${escapeHtml(messages.attentionReviewed)}</p>` : ""}
      ${page.unreadAttentionCount === undefined ? "" : `<p class="notice" data-unread-attention-count="true">${escapeHtml(messages.unreadAttentionCount)}: ${page.unreadAttentionCount}</p>`}
      <form method="get" action="/app">
        <input type="hidden" name="lang" value="${language}">
        <label for="timeline-namespace">${escapeHtml(messages.timelineNamespace)}</label>
        <input id="timeline-namespace" name="namespace" value="${escapeHtml(timelineQueryValue(query, "namespace"))}" maxlength="63">
        <label for="timeline-name">${escapeHtml(messages.timelineName)}</label>
        <input id="timeline-name" name="name" value="${escapeHtml(timelineQueryValue(query, "name"))}" maxlength="253">
        <label for="timeline-state">${escapeHtml(messages.timelineState)}</label>
        <select id="timeline-state" name="state"><option value="">${escapeHtml(messages.timelineAllStates)}</option>${["Pending", "Running", "Succeeded", "Failed", "Unknown"].map((stateValue) => `<option value="${stateValue}"${query.state === stateValue ? " selected" : ""}>${escapeHtml(timelineStateLabel(messages, stateValue))}</option>`).join("")}</select>
        <label for="timeline-attention">${escapeHtml(attentionLabel)}</label>
        <select id="timeline-attention" name="attention"><option value="">${escapeHtml(messages.timelineAllAttention)}</option><option value="true"${attentionFilter === "attention" ? " selected" : ""}>${escapeHtml(attentionOnlyLabel)}</option><option value="unread"${attentionFilter === "unread" ? " selected" : ""}>${escapeHtml(unreadAttentionOnlyLabel)}</option></select>
        <button type="submit">${escapeHtml(messages.filterTimeline)}</button>
      </form>
      ${rows || `<p>${escapeHtml(messages.noTimelineEntries)}</p>`}
      ${next}
      <script>
        (() => {
          const section = document.querySelector('[data-live-timeline="true"]');
          if (!section) return;
          const ids = new Set(Array.from(section.querySelectorAll('[data-entry-id]')).map((entry) => entry.getAttribute('data-entry-id')));
          let cursor = section.dataset.timelineCursor || null;
          let clientId = null;
          let recovering = false;
          let recoverAgain = false;
          const compareEntries = (left, right) => {
            const leftTime = Date.parse(left.occurredAt);
            const rightTime = Date.parse(right.occurredAt);
            if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
            return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
          };
          const append = (entry) => {
            if (!entry || typeof entry.id !== 'string' || typeof entry.occurredAt !== 'string' || ids.has(entry.id)) return;
            ids.add(entry.id);
            const article = document.createElement('article');
            article.dataset.entryId = entry.id;
            article.dataset.entryOccurredAt = entry.occurredAt;
            if (entry.entryType === 'experiment') article.textContent = 'Experiment · ' + (entry.experiment?.state || '');
            else article.textContent = (entry.observation?.kind || 'Observation') + ' · ' + (entry.observation?.name || '');
            const before = Array.from(section.querySelectorAll('[data-entry-id]')).find((candidate) => compareEntries(entry, {
              id: candidate.dataset.entryId || '', occurredAt: candidate.dataset.entryOccurredAt || ''
            }) < 0);
            section.insertBefore(article, before || section.querySelector('script'));
          };
          const recover = async () => {
            if (recovering) { recoverAgain = true; return; }
            recovering = true;
            try {
              do {
                recoverAgain = false;
                const params = new URLSearchParams({ limit: section.dataset.timelineLimit || '100' });
                for (const name of ['kind', 'namespace', 'name', 'state', 'attention', 'unread']) {
                  const value = section.dataset['timeline' + name[0].toUpperCase() + name.slice(1)];
                  if (value) params.set(name, value);
                }
                if (cursor) params.set('cursor', cursor);
                if (clientId) params.set('sseClientId', clientId);
                let response;
                try {
                  response = await fetch('/api/timeline?' + params.toString(), { headers: { accept: 'application/json' } });
                } catch {
                  reconnect();
                  return;
                }
                if (!response.ok) {
                  reconnect();
                  return;
                }
                let page;
                try {
                  page = await response.json();
                } catch {
                  reconnect();
                  return;
                }
                for (const entry of page.entries || []) append(entry);
                if (typeof page.resumeCursor === 'string') cursor = page.resumeCursor;
                if (typeof page.nextCursor === 'string') {
                  cursor = page.nextCursor;
                  recoverAgain = true;
                }
              } while (recoverAgain);
            } finally {
              recovering = false;
              if (recoverAgain) void recover();
            }
          };
          let source = null;
          window.__tracegardenTimelineReadyCount = 0;
          window.__tracegardenTimelineHintCount = 0;
          const connect = () => {
            const nextSource = new EventSource('/api/timeline/stream');
            source = nextSource;
            nextSource.addEventListener('ready', (event) => {
              window.__tracegardenTimelineReadyCount += 1;
              try { clientId = JSON.parse(event.data).clientId || null; } catch { clientId = null; }
              // The server emits ready only after subscribing, so this closes the query-to-LISTEN gap.
              void recover();
            });
            nextSource.addEventListener('error', () => { if (source === nextSource) clientId = null; });
            nextSource.addEventListener('timeline', () => {
              window.__tracegardenTimelineHintCount += 1;
              void recover();
            });
            window.__tracegardenTimelineEventSource = nextSource;
          };
          const reconnect = () => {
            source?.close();
            clientId = null;
            connect();
          };
          window.__tracegardenTimelineReconnect = reconnect;
          connect();
        })();
      </script>
    </section>`;
}

export function renderApplicationPage(
  language: Language,
  session: AuthenticatedSession,
  scope: ClusterScope | null = null,
  feedback?: Readonly<{ saved?: boolean; error?: string; logResult?: RecentLogWindow; logError?: string; attentionReviewed?: boolean; experimentSaved?: "created" | "updated"; experimentError?: string; correlationDecision?: "confirmed" | "rejected"; correlationError?: string; retentionSaved?: boolean; retentionResult?: RetentionCleanupResult; retentionError?: string }>,
  timelineEntries: readonly TimelineEntry[] = [],
  timelinePageOrExperiments: TimelinePage | readonly ExperimentRecord[] = [],
  timelineQuery?: TimelineQuery,
  experiments: readonly ExperimentRecord[] = [],
  correlationSuggestions: readonly CorrelationSuggestionRecord[] = [],
  retentionPolicy: RetentionPolicy | null = null,
): string {
  const messages = messagesFor(language);
  const member = session.member;
  const timelinePage: TimelinePage = Array.isArray(timelinePageOrExperiments)
    ? { entries: timelineEntries, nextCursor: null }
    : timelinePageOrExperiments as TimelinePage;
  const listedExperiments: readonly ExperimentRecord[] = Array.isArray(timelinePageOrExperiments)
    ? timelinePageOrExperiments as readonly ExperimentRecord[]
    : experiments;
  const capabilityList = member.capabilities.map((capability) => `<li>${escapeHtml(capability)}</li>`).join("");
  const membershipLink = hasCapability(member, capabilities.membershipManage)
    ? `<p><a href="/members?lang=${language}">${escapeHtml(messages.membershipTitle)}</a></p>`
    : "";
  return `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(messages.appName)} · ${escapeHtml(messages.workspaceTitle)}</title>
    ${pageStyles()}
  </head>
  <body>
    <main>
      <p class="hint">${escapeHtml(messages.appName)}</p>
      <h1>${escapeHtml(messages.workspaceTitle)}</h1>
      <p>${escapeHtml(messages.welcome)}, ${escapeHtml(member.identity.displayName)}.</p>
      <p><strong>${escapeHtml(messages.signedInAs)}:</strong> ${escapeHtml(member.identity.email)}</p>
      <h2>${escapeHtml(messages.capabilities)}</h2>
      <ul class="capabilities">${capabilityList}</ul>
      ${membershipLink}
      ${renderClusterSection(language, messages, member, scope, feedback)}
      ${renderRetentionSection(language, messages, member, retentionPolicy, {
        ...(feedback?.retentionSaved ? { saved: feedback.retentionSaved } : {}),
        ...(feedback?.retentionResult ? { result: feedback.retentionResult } : {}),
        ...(feedback?.retentionError ? { error: feedback.retentionError } : {}),
      })}
      ${hasCapability(member, capabilities.timelineRead) ? renderTimelineSection(language, messages, timelinePage, timelineQuery ?? { limit: 100 }, feedback?.attentionReviewed) : ""}
      ${hasCapability(member, capabilities.timelineRead) ? renderExperimentsSection(language, messages, member, listedExperiments, {
        ...(feedback?.experimentSaved ? { saved: feedback.experimentSaved } : {}),
        ...(feedback?.experimentError ? { error: feedback.experimentError } : {}),
      }) : ""}
      ${hasCapability(member, capabilities.timelineRead) ? renderCorrelationSection(language, messages, member, correlationSuggestions, timelinePage.entries, {
        ...(feedback?.correlationDecision ? { decision: feedback.correlationDecision } : {}),
        ...(feedback?.correlationError ? { error: feedback.correlationError } : {}),
      }) : ""}
      ${renderRecentLogsSection(language, messages, member, scope, feedback)}
      <form method="post" action="/auth/logout?lang=${language}">
        <button type="submit">${escapeHtml(messages.signOut)}</button>
      </form>
      ${renderLanguageLinks(language, messages, "/app")}
    </main>
  </body>
</html>`;
}

function invitationStatus(invitation: InvitationRecord, messages: Messages): string {
  return invitation.revokedAt ? messages.revoked : invitation.acceptedAt ? messages.accepted : messages.pending;
}

function renderRetentionSection(
  language: Language,
  messages: Messages,
  member: AuthenticatedSession["member"],
  policy: RetentionPolicy | null,
  feedback?: Readonly<{ saved?: boolean; result?: RetentionCleanupResult; error?: string }>,
): string {
  const policyDays = policy?.retentionDays ?? 90;
  const result = feedback?.result;
  const resultMessage = result
    ? result.failures > 0
      ? messages.retentionCleanupFailed
      : retentionMessage(messages.retentionCleanupComplete, result)
    : "";
  const controls = hasRetentionManagement(member)
    ? `<form method="post" action="/retention/update?lang=${language}">
        <label for="retention-days">${escapeHtml(messages.retentionDays)}</label>
        <input id="retention-days" name="retentionDays" type="number" min="1" max="3650" step="1" required value="${policyDays}">
        <button type="submit">${escapeHtml(messages.saveRetention)}</button>
      </form>
      <form method="post" action="/retention/cleanup?lang=${language}">
        <button type="submit">${escapeHtml(messages.runRetentionCleanup)}</button>
      </form>`
    : `<p class="error" role="alert">${escapeHtml(messages.retentionManageDenied)}</p>`;
  return `<section aria-labelledby="retention-title">
      <h2 id="retention-title">${escapeHtml(messages.retentionTitle)}</h2>
      <p>${escapeHtml(messages.retentionDescription)}</p>
      ${feedback?.saved ? `<p class="notice" role="status">${escapeHtml(messages.retentionSaved)}</p>` : ""}
      ${feedback?.error ? `<p class="error" role="alert">${escapeHtml(feedback.error)}</p>` : ""}
      ${resultMessage ? `<p class="${result?.failures ? "error" : "notice"}" role="status">${escapeHtml(resultMessage)}</p>` : ""}
      <p><strong>${escapeHtml(messages.retentionDays)}:</strong> ${policyDays}</p>
      ${controls}
    </section>`;
}

function renderRecentLogsSection(
  language: Language,
  messages: Messages,
  member: AuthenticatedSession["member"],
  scope: ClusterScope | null,
  feedback?: Readonly<{ logResult?: RecentLogWindow; logError?: string }>,
): string {
  const form = hasLogReadCapability(member)
    ? `<form method="post" action="/logs/recent?lang=${language}">
        <label for="log-cluster">${escapeHtml(messages.logCluster)}</label>
        <input id="log-cluster" name="clusterId" required value="${escapeHtml(scope?.clusterId ?? "")}" autocomplete="off">
        <label for="log-namespace">${escapeHtml(messages.logNamespace)}</label>
        <input id="log-namespace" name="namespace" required value="${escapeHtml(scope?.namespaces[0] ?? "")}" autocomplete="off">
        <label for="log-pod">${escapeHtml(messages.logPod)}</label>
        <input id="log-pod" name="pod" required autocomplete="off">
        <label for="log-container">${escapeHtml(messages.logContainer)}</label>
        <input id="log-container" name="container" required autocomplete="off">
        <label for="log-tail">${escapeHtml(messages.logTail)}</label>
        <input id="log-tail" name="tail" type="number" min="1" max="200" value="50" required>
        <button type="submit">${escapeHtml(messages.requestLogs)}</button>
      </form>`
    : `<p class="error" role="alert">${escapeHtml(messages.logsReadDenied)}</p>`;
  const result = feedback?.logResult
    ? `<p class="hint">${escapeHtml(messages.recentLogsMetadata)} ${feedback.logResult.lineCount} lines · ${feedback.logResult.byteCount} bytes</p><pre aria-label="${escapeHtml(messages.recentLogsTitle)}">${escapeHtml(feedback.logResult.body || messages.recentLogsEmpty)}</pre>`
    : "";
  return `<section aria-labelledby="recent-logs-title">
      <h2 id="recent-logs-title">${escapeHtml(messages.recentLogsTitle)}</h2>
      <p>${escapeHtml(messages.recentLogsDescription)}</p>
      ${feedback?.logError ? `<p class="error" role="alert">${escapeHtml(feedback.logError)}</p>` : ""}
      ${form}
      ${result}
    </section>`;
}

export function renderMembersPage(
  language: Language,
  session: AuthenticatedSession,
  members: readonly MemberRecord[],
  invitations: readonly InvitationRecord[],
  notice?: string,
): string {
  const messages = messagesFor(language);
  const memberRows = members.map((member) => `<tr>
      <td>${escapeHtml(member.identity.displayName)}<br><span class="hint">${escapeHtml(member.identity.email)}</span></td>
      <td><form method="post" action="/members/role">
        <input type="hidden" name="lang" value="${language}">
        <input type="hidden" name="memberId" value="${escapeHtml(member.id)}">
        <label><span class="hint">${escapeHtml(messages.role)}</span>
          <select name="role" aria-label="${escapeHtml(messages.role)}: ${escapeHtml(member.identity.email)}">
            ${["owner", "operator", "viewer"].map((role) => `<option value="${role}"${member.role === role ? " selected" : ""}>${role}</option>`).join("")}
          </select>
        </label>
        <button type="submit">${escapeHtml(messages.saveRole)}</button>
      </form></td>
    </tr>`).join("");
  const invitationRows = invitations.map((invitation) => `<tr>
      <td>${escapeHtml(invitation.email)}</td>
      <td>${escapeHtml(invitationStatus(invitation, messages))}</td>
      <td>${invitation.revokedAt || invitation.acceptedAt ? "" : `<form method="post" action="/members/revoke"><input type="hidden" name="lang" value="${language}"><input type="hidden" name="invitationId" value="${escapeHtml(invitation.id)}"><button type="submit">${escapeHtml(messages.revokeInvitation)}</button></form>`}</td>
    </tr>`).join("");
  return `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(messages.appName)} · ${escapeHtml(messages.membershipTitle)}</title>
    ${pageStyles()}
  </head>
  <body>
    <main>
      <p class="hint">${escapeHtml(messages.appName)}</p>
      <h1>${escapeHtml(messages.membershipTitle)}</h1>
      <p><strong>${escapeHtml(messages.signedInAs)}:</strong> ${escapeHtml(session.member.identity.email)}</p>
      ${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ""}
      <h2>${escapeHtml(messages.members)}</h2>
      <table><thead><tr><th>${escapeHtml(messages.members)}</th><th>${escapeHtml(messages.role)}</th></tr></thead><tbody>${memberRows || `<tr><td colspan="2">—</td></tr>`}</tbody></table>
      <h2>${escapeHtml(messages.invitations)}</h2>
      <form method="post" action="/members/invite">
        <input type="hidden" name="lang" value="${language}">
        <label for="invite-email">${escapeHtml(messages.inviteEmail)}</label>
        <input id="invite-email" name="email" type="email" required autocomplete="email">
        <button type="submit">${escapeHtml(messages.createInvitation)}</button>
      </form>
      <table><thead><tr><th>${escapeHtml(messages.inviteEmail)}</th><th>${escapeHtml(messages.role)}</th><th></th></tr></thead><tbody>${invitationRows || `<tr><td colspan="3">—</td></tr>`}</tbody></table>
      <p><a href="/app?lang=${language}">${escapeHtml(messages.workspaceTitle)}</a></p>
      <form method="post" action="/auth/logout?lang=${language}"><button type="submit">${escapeHtml(messages.signOut)}</button></form>
      ${renderLanguageLinks(language, messages, "/members")}
    </main>
  </body>
</html>`;
}

export function renderMembershipDeniedPage(language: Language): string {
  const messages = messagesFor(language);
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><title>${escapeHtml(messages.appName)} · ${escapeHtml(messages.membershipTitle)}</title>${pageStyles()}</head><body><main><h1>${escapeHtml(messages.membershipTitle)}</h1><p role="alert">${escapeHtml(messages.membershipDenied)}</p><p><a href="/app?lang=${language}">${escapeHtml(messages.workspaceTitle)}</a></p><form method="post" action="/auth/logout?lang=${language}"><button type="submit">${escapeHtml(messages.signOut)}</button></form>${renderLanguageLinks(language, messages, "/members")}</main></body></html>`;
}

export function renderRejectionPage(language: Language, reason: "admission_required" | "invalid_identity"): string {
  const messages = messagesFor(language);
  const description = reason === "admission_required" ? messages.rejectionDescription : messages.admissionRequired;
  return `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(messages.appName)} · ${escapeHtml(messages.rejectionTitle)}</title>
    ${pageStyles()}
  </head>
  <body>
    <main>
      <p class="hint">${escapeHtml(messages.appName)}</p>
      <h1>${escapeHtml(messages.rejectionTitle)}</h1>
      <p role="alert">${escapeHtml(description)}</p>
      <p><a href="/?lang=${language}">${escapeHtml(messages.signIn)}</a></p>
      <form method="post" action="/auth/logout?lang=${language}">
        <button type="submit">${escapeHtml(messages.signOut)}</button>
      </form>
      ${renderLanguageLinks(language, messages)}
    </main>
  </body>
</html>`;
}

function cookies(request: Request): Readonly<Record<string, string>> {
  const header = request.headers.get("cookie") ?? "";
  return Object.fromEntries(header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return [];
    try {
      return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
    } catch {
      return [];
    }
  }));
}

type RequestFields = Readonly<Record<string, string>>;

function requestFields(body: string, contentType: string | undefined): RequestFields | null {
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json") {
    try {
      const value: unknown = JSON.parse(body);
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
      const fields: Record<string, string> = {};
      for (const [key, field] of Object.entries(value)) {
        if (typeof field !== "string") return null;
        fields[key] = field;
      }
      return fields;
    } catch {
      return null;
    }
  }
  const form = new URLSearchParams(body);
  return Object.fromEntries(form.entries());
}

function cookieHeader(token: string, production: boolean): string {
  return `tracegarden_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax${production ? "; Secure" : ""}`;
}

type BetterAuthDatabase = DatabaseBoundary & {
  betterAuth(environment: Record<string, string | undefined>): Promise<BetterAuthRuntime>;
};

function hasBetterAuth(value: DatabaseBoundary): value is BetterAuthDatabase {
  return "betterAuth" in value && typeof value.betterAuth === "function";
}

function hasMembershipStore(value: AdmissionStore): value is AdmissionStore & MembershipStore {
  return typeof value.createInvitation === "function"
    && typeof value.revokeInvitation === "function"
    && typeof value.listInvitations === "function"
    && typeof value.listMembers === "function"
    && typeof value.assignMemberRole === "function"
    && typeof value.listAuditRecords === "function";
}

function hasLogAuditStore(value: AdmissionStore): value is AdmissionStore & LogAuditStore {
  return typeof (value as Partial<LogAuditStore>).recordLogAccess === "function";
}

function hasExperimentStore(value: TimelineStore | null): value is TimelineStore & ExperimentStore {
  if (!value) return false;
  const candidate = value as Partial<ExperimentStore>;
  return typeof candidate.createExperiment === "function"
    && typeof candidate.updateExperiment === "function"
    && typeof candidate.getExperiment === "function"
    && typeof candidate.listExperiments === "function";
}

function hasCorrelationStore(value: TimelineStore | null): value is TimelineStore & {
  listCorrelationSuggestions: NonNullable<TimelineStore["listCorrelationSuggestions"]>;
  getCorrelationSuggestion: NonNullable<TimelineStore["getCorrelationSuggestion"]>;
  decideCorrelationSuggestion: NonNullable<TimelineStore["decideCorrelationSuggestion"]>;
  listConfirmedLinks: NonNullable<TimelineStore["listConfirmedLinks"]>;
} {
  if (!value) return false;
  const candidate = value as Partial<TimelineStore>;
  return typeof candidate.listCorrelationSuggestions === "function"
    && typeof candidate.getCorrelationSuggestion === "function"
    && typeof candidate.decideCorrelationSuggestion === "function"
    && typeof candidate.listConfirmedLinks === "function";
}

function hasRetentionStore(value: unknown): value is RetentionStore {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RetentionStore>;
  return typeof candidate.getRetentionPolicy === "function"
    && typeof candidate.updateRetentionPolicy === "function"
    && typeof candidate.cleanupRetention === "function";
}

function retentionMessage(template: string, result: RetentionCleanupResult): string {
  return template.replace("{eligible}", String(result.eligibleObservations))
    .replace("{protected}", String(result.protectedObservations))
    .replace("{deleted}", String(result.deletedObservations))
    .replace("{entries}", String(result.deletedTimelineEntries))
    .replace("{failures}", String(result.failures));
}

function retentionCleanupQueryResult(query: Readonly<Record<string, string>>, policy: RetentionPolicy | null): RetentionCleanupResult | undefined {
  if (query.retention !== "cleanup" || !policy) return undefined;
  const integer = (name: string): number => {
    const value = Number(query[name]);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  const failures = integer("failures");
  return {
    workspaceId: policy.workspaceId,
    retentionDays: policy.retentionDays,
    cutoff: "",
    eligibleObservations: integer("eligible"),
    protectedObservations: integer("protected"),
    deletedObservations: integer("deleted"),
    deletedTimelineEntries: integer("entries"),
    failures,
    failureCount: failures,
    retryable: true,
  };
}

function requestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (["x-request-id", "x-trace-id", "traceparent"].includes(name.toLowerCase())) continue;
    headers.set(name, value);
  }
  return headers;
}

function listenForStartup(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onListening = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const onError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      server.removeListener("listening", onListening);
      reject(error);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      onError(error);
    }
  });
}

type WebBindings = HttpBindings;
type WebVariables = {
  correlation: CorrelationMetadata;
  requestSpan: TelemetrySpan;
};
type WebContext = { Bindings: WebBindings; Variables: WebVariables };
type AppContext = Context<WebContext>;

export async function createWebRuntime(options: WebOptions = {}): Promise<WebRuntime> {
  const environment = options.environment ?? process.env;
  const production = environment.NODE_ENV === "production";
  const preview = environment.NODE_ENV === "preview";
  const cloudflareAccess = configuredCloudflareAccess(environment);
  if (preview && !cloudflareAccess) {
    throw new Error("Preview identity requires complete Cloudflare Access JWT configuration");
  }
  if (production && options.telemetry) {
    throw new Error("Production web instrumentation must be application-owned");
  }
  const telemetry = options.telemetry ?? createTelemetry({
    serviceName: "tracegarden-web",
    logExporter: (signal) => console.log(JSON.stringify(signal)),
    traceExporter: (signal) => console.log(JSON.stringify(signal)),
  });
  const startupCorrelation = telemetry.correlation("web-startup");
  telemetry.log("info", "web.starting", startupCorrelation);
  const database = options.database ?? createDatabase(environment);
  if (environment.NODE_ENV === "production" && database.kind === "memory") {
    throw new Error("Memory database is not allowed in production");
  }
  if (environment.NODE_ENV === "production" && !environment.TIMELINE_CURSOR_SECRET?.trim()) {
    await database.close();
    throw new Error("TIMELINE_CURSOR_SECRET is required in production");
  }
  if (preview && options.identityAdapter) {
    await database.close();
    throw new Error("Preview identity cannot use a local identity adapter");
  }
  const identityAdapter = options.identityAdapter ?? createIdentityAdapter(environment);
  const logAdapter = options.logAdapter ?? createKubernetesLogAdapter(environment);
  if (environment.NODE_ENV === "production" && options.logAdapter) {
    await database.close();
    throw new Error("Production Recent Log Window must use the configured Kubernetes log adapter");
  }
  let admissionStore: AdmissionStore;
  let clusterScopeStore: ClusterScopeStore;
  if (environment.NODE_ENV === "production") {
    if (options.admissionStore || options.identityAdapter || database.kind !== "postgres" || !database.admission) {
      await database.close();
      throw new Error("Production admission must use the database-owned durable store");
    }
    if (options.clusterScopeStore || !database.clusterScope) {
      await database.close();
      throw new Error("Production Cluster scope must use the database-owned durable store");
    }
    if (options.timelineStore || !database.timeline) {
      await database.close();
      throw new Error("Production Timeline must use the database-owned durable store");
    }
    if (options.experimentStore || !database.experiments) {
      await database.close();
      throw new Error("Production Experiment must use the database-owned durable store");
    }
    if (!hasCorrelationStore(database.timeline ?? null)) {
      await database.close();
      throw new Error("Production Correlation must use the database-owned durable store");
    }
    if (options.retentionStore || !hasRetentionStore(database.retention ?? database.timeline ?? null)) {
      await database.close();
      throw new Error("Production Retention must use the database-owned durable store");
    }
    admissionStore = database.admission;
    clusterScopeStore = database.clusterScope;
  } else {
    admissionStore = options.admissionStore ?? database.admission ?? new MemoryAdmissionStore();
    clusterScopeStore = options.clusterScopeStore ?? database.clusterScope ?? new MemoryClusterScopeStore();
  }
  if (environment.NODE_ENV === "production") {
    const bootstrapIdentity = configuredBootstrapIdentity(environment);
    const betterAuthURL = environment.BETTER_AUTH_URL?.trim();
    let secureBaseURL = false;
    try {
      secureBaseURL = new URL(betterAuthURL ?? "").protocol === "https:";
    } catch {
      secureBaseURL = false;
    }
    if (bootstrapIdentity.issuer !== GOOGLE_ISSUER) {
      await database.close();
      throw new Error("Production bootstrap identity must use the Google issuer");
    }
    if (!secureBaseURL) {
      await database.close();
      throw new Error("BETTER_AUTH_URL must be HTTPS in production");
    }
  }
  let migrationReady = false;
  let databaseReady = false;
  let startupState: "starting" | "ready" | "failed" = "starting";
  try {
    await waitForDatabase(
      database,
      Number(environment.MIGRATION_DATABASE_READY_TIMEOUT_SECONDS ?? 120) * 1000,
      Number(environment.MIGRATION_DATABASE_READY_RETRY_SECONDS ?? 2) * 1000,
    );
    databaseReady = true;
    if (database.verifyMigrations) await database.verifyMigrations();
    else if (database.kind !== "memory" && database.migrationStatus?.() !== "ready") {
      throw new Error("Tracegarden database migration state cannot be verified");
    }
    migrationReady = database.migrationStatus?.() !== "failed";
  } catch (error) {
    startupState = "failed";
    telemetry.log("error", "web.startup.failure", startupCorrelation, { error_type: error instanceof Error ? error.name : "unknown" });
    await database.close();
    throw error;
  }
  let betterAuthRuntime: BetterAuthRuntime | undefined;
  if (environment.NODE_ENV === "production") {
    if (identityAdapter.kind !== "google") {
      await database.close();
      throw new Error("Production identity must use Google OAuth");
    }
    if (!hasBetterAuth(database)) {
      await database.close();
      throw new Error("Production authentication requires Better Auth with PostgreSQL");
    }
    try {
      betterAuthRuntime = await database.betterAuth(environment);
    } catch (error) {
      startupState = "failed";
      telemetry.log("error", "web.startup.failure", startupCorrelation, { error_type: error instanceof Error ? error.name : "unknown" });
      await database.close();
      throw error;
    }
  }

  type LiveSseClient = {
    workspaceId: string;
    memberId: string;
    pendingNotification: TimelineNotification | null;
    readySent: boolean;
    hintCheckInFlight: boolean;
    hintQueued: boolean;
    query?: TimelineQuery;
    cursorLagEntries: number;
    cursorLagSince: number | null;
    sendPendingHint?: () => void;
    close: () => void;
  };
  const liveSseClients = new Map<string, LiveSseClient>();
  let timelineReady = false;
  let stopping = false;
  const refreshLiveClientLag = async (client: LiveSseClient): Promise<void> => {
    if (!client.query || !timelineStore?.countTimelineEntriesAfterCursor) return;
    try {
      const lag = await timelineStore.countTimelineEntriesAfterCursor(client.workspaceId, client.query, client.memberId);
      if (client.cursorLagEntries === 0 && lag > 0) client.cursorLagSince = Date.now();
      if (lag === 0) client.cursorLagSince = null;
      client.cursorLagEntries = lag;
    } catch {
      // Cursor lag is telemetry; a failed measurement must not affect the stream.
    }
  };
  const refreshLiveSignals = async (): Promise<void> => {
    await Promise.all([...liveSseClients.values()].map((client) => refreshLiveClientLag(client)));
  };
  const liveSignalSnapshot = (): Readonly<{ sseClients: number; cursorLagEntries: number; cursorLagSeconds: number }> => {
    let cursorLagEntries = 0;
    let cursorLagSince: number | null = null;
    for (const client of liveSseClients.values()) {
      cursorLagEntries += client.cursorLagEntries;
      if (client.cursorLagSince !== null && (cursorLagSince === null || client.cursorLagSince < cursorLagSince)) cursorLagSince = client.cursorLagSince;
    }
    return {
      sseClients: liveSseClients.size,
      cursorLagEntries,
      cursorLagSeconds: cursorLagSince === null ? 0 : Math.max(0, (Date.now() - cursorLagSince) / 1_000),
    };
  };

  const status = async (): Promise<StatusResponse> => {
    try {
      databaseReady = await database.ping();
    } catch {
      databaseReady = false;
    }
    try {
      const migrationStatus = database.migrationStatus?.();
      if (migrationStatus === "failed" || migrationStatus === "pending") migrationReady = false;
      if (migrationStatus === "ready") migrationReady = true;
    } catch {
      migrationReady = false;
    }
    if (stopping) {
      databaseReady = false;
      migrationReady = false;
      timelineReady = false;
    } else {
      await verifyTimelineNotifications();
      await refreshLiveSignals();
    }
    syncWebMetrics();
    const readiness = state(!stopping && databaseReady && migrationReady && timelineReady && startupState === "ready");
    return {
      service: "tracegarden-web",
      status: readiness,
      startup: startupState,
      readiness,
      liveness: stopping ? "stopping" : "alive",
      checks: {
        database: state(databaseReady),
        migrations: state(migrationReady),
        timeline: state(timelineReady),
      },
      signals: liveSignalSnapshot(),
    };
  };

  type RequestSession = Readonly<{
    session: AuthenticatedSession | null;
    rejection?: "admission_required" | "invalid_identity";
  }>;

  const sessionForRequest = async (request: Request): Promise<RequestSession> => {
    if (cloudflareAccess) {
      const identity = cloudflareAccessIdentity(requestHeaders(request), cloudflareAccess);
      if (identity) {
        const admission = await admissionStore.admit(identity, {
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        return admission.admitted
          ? { session: admission.session }
          : { session: null, rejection: admission.reason };
      }
      return { session: null };
    }
    if (betterAuthRuntime) {
      const authenticated = await betterAuthRuntime.session(requestHeaders(request));
      if (!authenticated) return { session: null };
      const identity: ExternalIdentity = {
        issuer: GOOGLE_ISSUER,
        subject: authenticated.subject,
        email: authenticated.user.email,
        displayName: authenticated.user.name?.trim() || authenticated.user.email,
      };
      const admission = await admissionStore.admit(identity, {
        token: authenticated.token,
        expiresAt: authenticated.expiresAt,
      });
      return admission.admitted
        ? { session: admission.session }
        : { session: null, rejection: admission.reason };
    }
    const token = cookies(request).tracegarden_session;
    return { session: token ? await admissionStore.getSession(token) : null };
  };

  const hasWorkspaceAccess = (session: AuthenticatedSession | null): boolean => {
    if (!session) return false;
    try {
      requireCapability(session.member, capabilities.workspaceRead);
      return true;
    } catch {
      return false;
    }
  };
  const hasTimelineAccess = (session: AuthenticatedSession | null): boolean => {
    if (!session || !hasWorkspaceAccess(session)) return false;
    try {
      requireCapability(session.member, capabilities.timelineRead);
      return true;
    } catch {
      return false;
    }
  };
  const membershipStore = hasMembershipStore(admissionStore) ? admissionStore : null;
  const timelineStore = environment.NODE_ENV === "production"
    ? database.timeline ?? null
    : options.timelineStore ?? database.timeline ?? null;
  const experimentStore = environment.NODE_ENV === "production"
    ? database.experiments ?? null
    : options.experimentStore ?? database.experiments ?? (hasExperimentStore(timelineStore) ? timelineStore : null);
  const retentionStore: RetentionStore | null = environment.NODE_ENV === "production"
    ? database.retention ?? (hasRetentionStore(database.timeline) ? database.timeline : null)
    : options.retentionStore ?? database.retention ?? (hasRetentionStore(timelineStore) ? timelineStore : null);
  const logAuditStore = hasLogAuditStore(admissionStore) ? admissionStore : undefined;
  const timelineNotifications = timelineStore && "subscribeTimeline" in timelineStore && typeof timelineStore.subscribeTimeline === "function"
    ? timelineStore as TimelineNotificationSource
    : null;
  const removeTimelineErrorListener = timelineNotifications?.onTimelineError?.(() => {
    timelineReady = false;
    telemetry.log("warn", "timeline.notifications.unhealthy", telemetry.correlation("timeline-notifications"));
    for (const client of [...liveSseClients.values()]) client.close();
  });
  const defineWebMetrics = (): void => {
    telemetry.defineGauge("tracegarden_sse_clients");
    telemetry.defineGauge("tracegarden_timeline_cursor_lag_entries");
    telemetry.defineGauge("tracegarden_timeline_cursor_lag_seconds");
    telemetry.defineGauge("tracegarden_database_pool_total");
    telemetry.defineGauge("tracegarden_database_pool_idle");
    telemetry.defineGauge("tracegarden_database_pool_waiting");
    telemetry.defineGauge("tracegarden_database_ready");
    telemetry.defineGauge("tracegarden_migrations_ready");
    telemetry.defineGauge("tracegarden_migration_status");
    telemetry.defineCounter("tracegarden_recent_log_access_total", { result: "success" });
  };
  defineWebMetrics();
  const syncWebMetrics = (): void => {
    const signals = liveSignalSnapshot();
    const correlation = telemetry.correlation("web-signals");
    let pool = { total: 0, idle: 0, waiting: 0 };
    try {
      pool = database.poolState?.() ?? pool;
    } catch {
      // Pool gauges are diagnostic and cannot affect request or probe behavior.
    }
    telemetry.setGauge("tracegarden_sse_clients", signals.sseClients, {}, correlation);
    telemetry.setGauge("tracegarden_timeline_cursor_lag_entries", signals.cursorLagEntries, {}, correlation);
    telemetry.setGauge("tracegarden_timeline_cursor_lag_seconds", signals.cursorLagSeconds, {}, correlation);
    telemetry.setGauge("tracegarden_database_pool_total", pool.total, {}, correlation);
    telemetry.setGauge("tracegarden_database_pool_idle", pool.idle, {}, correlation);
    telemetry.setGauge("tracegarden_database_pool_waiting", pool.waiting, {}, correlation);
    telemetry.setGauge("tracegarden_database_ready", databaseReady ? 1 : 0, {}, correlation);
    telemetry.setGauge("tracegarden_migrations_ready", migrationReady ? 1 : 0, {}, correlation);
    let migrationValue = migrationReady ? 1 : 0;
    try {
      if (database.migrationStatus?.() === "failed") migrationValue = -1;
    } catch {
      migrationValue = -1;
    }
    telemetry.setGauge("tracegarden_migration_status", migrationValue, {}, correlation);
  };

  const recentLogTelemetry = (correlation: CorrelationMetadata) => ({
    structuredLog: (event: RecentLogTelemetryEvent) => telemetry.log("info", event.action, correlation, event),
    trace: (event: RecentLogTelemetryEvent) => {
      const span = telemetry.startSpan(event.action, correlation, event);
      span.end();
    },
    metric: (_event: RecentLogTelemetryEvent) => telemetry.increment("tracegarden_recent_log_access_total", 1, { result: "success" }, correlation),
    analytics: (event: RecentLogTelemetryEvent) => telemetry.log("debug", "recent_log.analytics", correlation, { clusterId: event.clusterId, namespace: event.namespace, pod: event.pod, container: event.container, tail: event.tail, lineCount: event.lineCount, byteCount: event.byteCount }),
  });

  let releaseTimelineReadiness: (() => void) | undefined;
  const timelineNotificationsAreHealthy = (): boolean => {
    try {
      return timelineNotifications?.timelineNotificationsHealthy?.() !== false;
    } catch {
      return false;
    }
  };
  const verifyTimelineNotifications = async (): Promise<void> => {
    if (stopping) {
      timelineReady = false;
      return;
    }
    if (!timelineNotifications) {
      timelineReady = false;
      return;
    }
    if (releaseTimelineReadiness && timelineNotificationsAreHealthy()) {
      timelineReady = true;
      return;
    }
    releaseTimelineReadiness?.();
    releaseTimelineReadiness = undefined;
    try {
      const unsubscribe = await timelineNotifications.subscribeTimeline(() => {});
      if (!timelineNotificationsAreHealthy()) {
        unsubscribe();
        timelineReady = false;
        return;
      }
      releaseTimelineReadiness = unsubscribe;
      timelineReady = true;
    } catch {
      timelineReady = false;
      telemetry.log("warn", "timeline.notifications.unavailable", telemetry.correlation("timeline-notifications"));
    }
  };
  await verifyTimelineNotifications();

  const scopeForSession = (session: AuthenticatedSession): Promise<ClusterScope | null> => clusterScopeStore.get(session.member.workspaceId);
  const correlationSuggestionsForSession = async (session: AuthenticatedSession): Promise<readonly CorrelationSuggestionRecord[]> =>
    hasCorrelationStore(timelineStore) ? timelineStore.listCorrelationSuggestions(session.member.workspaceId) : [];
  const retentionPolicyForSession = async (session: AuthenticatedSession): Promise<RetentionPolicy | null> =>
    retentionStore ? retentionStore.getRetentionPolicy(session.member.workspaceId) : null;

  const formScopeInput = (form: URLSearchParams): Record<string, unknown> => {
    const clusterId = form.get("clusterId")?.trim();
    return {
      ...(clusterId ? { clusterId } : {}),
      name: form.get("name") ?? "",
      endpoint: form.get("endpoint") ?? "",
      namespaces: (form.get("namespaces") ?? "").split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
      resourceKinds: form.getAll("resourceKinds"),
    };
  };

  const formLogInput = (form: URLSearchParams): Record<string, unknown> => ({
    clusterId: form.get("clusterId") ?? "",
    namespace: form.get("namespace") ?? "",
    pod: form.get("pod") ?? "",
    container: form.get("container") ?? "",
    tail: Number(form.get("tail") ?? ""),
  });

  const timelineQueryInput = (query: Readonly<Record<string, string>>, allowInternalFlash = false): Record<string, unknown> => {
    const attention = query.attention;
    return {
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.namespace === undefined ? {} : { namespace: query.namespace }),
      ...(query.name === undefined ? {} : { name: query.name }),
      ...(query.state !== undefined ? { state: query.state } : query.phase === undefined ? {} : { phase: query.phase }),
      ...(attention === undefined || attention === "" || (allowInternalFlash && attention === "reviewed") ? {} : { attention: attention === "unread" ? "true" : attention, ...(attention === "unread" ? { unread: "true" } : {}) }),
      ...(query.unread === undefined ? {} : { unread: query.unread }),
    };
  };

  const formExperimentInput = (form: URLSearchParams): Record<string, unknown> => ({
    hypothesis: form.get("hypothesis") ?? "",
    change: form.get("change") ?? "",
    observation: form.get("observation") ?? "",
    conclusion: form.get("conclusion") ?? "",
    state: form.get("state") ?? "draft",
    tags: (form.get("tags") ?? "").split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean),
    workloads: (form.get("workloads") ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const parts = line.split("|").map((value) => value.trim());
      if (parts.length !== 4) return line;
      const [clusterId = "", namespace = "", kind = "", name = ""] = parts;
      return { clusterId, namespace, kind, name };
    }),
    gitRevision: form.get("gitRevision")?.trim() || null,
  });

  const parseExperimentRequest = async (request: Request): Promise<unknown> => {
    const body = await request.text();
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json") {
      try {
        return JSON.parse(body) as unknown;
      } catch {
        return null;
      }
    }
    return formExperimentInput(new URLSearchParams(body));
  };

  const parseRetentionRequest = async (request: Request): Promise<unknown> => {
    const body = await request.text();
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json") {
      try {
        return JSON.parse(body) as unknown;
      } catch {
        return null;
      }
    }
    const form = new URLSearchParams(body);
    return { retentionDays: form.get("retentionDays") ?? form.get("days") ?? "" };
  };

  const requestText = async (context: AppContext): Promise<string> => {
    const body = await context.req.text();
    if (body.length > 8192) throw new Error("request body too large");
    return body;
  };
  const languageFor = (context: AppContext): Language => parseLanguage(context.req.query("lang"));
  const json = (context: AppContext, status: 200 | 201 | 400 | 401 | 403 | 404 | 405 | 409 | 503, payload: unknown): Response => context.json(payload, status);
  const html = (context: AppContext, status: 200 | 400 | 403 | 404 | 405 | 409 | 503, body: string): Response => context.html(body, status);
  const empty = (context: AppContext, status: 302 | 303): Response => context.body(null, status);
  const redirect = (context: AppContext, location: string, status: 302 | 303 = 303, headers?: HeadersInit): Response => {
    context.header("location", location);
    if (headers) for (const [name, value] of new Headers(headers)) context.header(name, value);
    return empty(context, status);
  };
  const responseFrom = (context: AppContext, source: Response): Response => {
    const headers = new Headers(source.headers);
    const requestSpan = context.get("requestSpan");
    headers.set("x-request-id", requestSpan.correlation.requestId);
    headers.set("x-trace-id", requestSpan.correlation.traceId);
    headers.set("traceparent", `00-${requestSpan.correlation.traceId}-${requestSpan.correlation.spanId}-01`);
    return context.newResponse(source.body, { status: source.status as 200, headers });
  };
  const requestForm = async (context: AppContext): Promise<RequestFields | null> => requestFields(await requestText(context), context.req.header("content-type"));
  const requestJson = async (context: AppContext): Promise<unknown> => {
    try {
      return JSON.parse(await requestText(context)) as unknown;
    } catch {
      return null;
    }
  };
  const authOrigin = (context: AppContext): string => environment.BETTER_AUTH_URL ?? new URL(context.req.url).origin;

  const betterAuth = async (context: AppContext): Promise<Response> => {
    if (!betterAuthRuntime) return context.req.method === "GET" ? context.notFound() : json(context, 405, { error: "method_not_allowed" });
    const body = context.req.method === "GET" || context.req.method === "HEAD" ? undefined : await requestText(context);
    const authRequest = new Request(new URL(context.req.url).toString(), {
      method: context.req.method,
      headers: requestHeaders(context.req.raw),
      ...(body === undefined ? {} : { body }),
    });
    return responseFrom(context, await betterAuthRuntime.handler(authRequest));
  };
  const login = async (context: AppContext): Promise<Response> => {
    const language = languageFor(context);
    if (context.req.method === "GET") {
      if (cloudflareAccess) return json(context, 401, { error: "cloudflare_access_jwt_required" });
      const current = await status();
      return html(context, current.status === "ready" ? 200 : 503, renderLoginPage(language, current.checks.database === "ready", identityAdapter));
    }
    if (cloudflareAccess || identityAdapter.kind !== "local") {
      return json(context, 405, { error: cloudflareAccess ? "cloudflare_access_jwt_required" : "google_login_required" });
    }
    const form = new URLSearchParams(await requestText(context));
    const selected = form.get("identity") ?? "";
    const selectedLanguage = parseLanguage(form.get("lang"));
    const identity = identityAdapter.resolve(selected);
    if (!identity) return html(context, 403, renderRejectionPage(selectedLanguage, "invalid_identity"));
    const admission = await admissionStore.admit(identity);
    if (!admission.admitted) return html(context, 403, renderRejectionPage(selectedLanguage, admission.reason));
    context.header("set-cookie", cookieHeader(admission.session.token, environment.NODE_ENV === "production"));
    return redirect(context, `/app?lang=${selectedLanguage}`);
  };
  const logout = async (context: AppContext): Promise<Response> => {
    const language = languageFor(context);
    if (betterAuthRuntime) {
      const authResponse = await betterAuthRuntime.handler(new Request(new URL("/api/auth/sign-out", authOrigin(context)).toString(), {
        method: "POST",
        headers: requestHeaders(context.req.raw),
      }));
      const headers = new Headers(authResponse.headers);
      headers.set("location", `/?lang=${language}`);
      headers.set("x-request-id", context.get("requestSpan").correlation.requestId);
      headers.set("x-trace-id", context.get("requestSpan").correlation.traceId);
      headers.set("traceparent", `00-${context.get("requestSpan").correlation.traceId}-${context.get("requestSpan").correlation.spanId}-01`);
      return context.newResponse(null, { status: 303, headers });
    }
    context.header("set-cookie", "tracegarden_session=; Max-Age=0; HttpOnly; Path=/; SameSite=Lax");
    return redirect(context, `/?lang=${language}`);
  };
  const googleLogin = async (context: AppContext): Promise<Response> => {
    if (!betterAuthRuntime) return context.notFound();
    const language = languageFor(context);
    const authResponse = await betterAuthRuntime.handler(new Request(new URL("/api/auth/sign-in/social", authOrigin(context)).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ provider: "google", callbackURL: `/app?lang=${language}` }),
    }));
    if (!authResponse.ok) return responseFrom(context, authResponse);
    const payload = await authResponse.json() as { url?: unknown };
    if (typeof payload.url !== "string") throw new Error("Better Auth did not return a Google authorization URL");
    const headers = new Headers(authResponse.headers);
    headers.set("location", payload.url);
    return responseFrom(context, new Response(null, { status: 302, headers }));
  };

  const unauthorized = (context: AppContext): Response => json(context, 401, { error: "unauthorized" });
  const workspaceSession = async (context: AppContext): Promise<RequestSession> => sessionForRequest(context.req.raw);
  const requireWorkspace = async (context: AppContext): Promise<AuthenticatedSession | Response> => {
    const lookup = await workspaceSession(context);
    if (!lookup.session || !hasWorkspaceAccess(lookup.session)) return unauthorized(context);
    return lookup.session;
  };
  const requireTimeline = async (context: AppContext): Promise<AuthenticatedSession | Response> => {
    const session = await requireWorkspace(context);
    if (session instanceof Response) return session;
    if (!hasTimelineAccess(session)) return json(context, 403, { error: "missing_capability", capability: capabilities.timelineRead });
    return session;
  };

  const timelineStream = async (context: AppContext): Promise<Response> => {
    const session = await requireTimeline(context);
    if (session instanceof Response) return session;
    if (!timelineNotifications) return json(context, 503, { error: "timeline_notifications_unavailable" });
    const clientId = randomUUID();
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    let stream: SSEStreamingApi | undefined;
    let finishStream = (): void => {};
    let restoreOutgoingWrite = (): void => {};
    const outgoing = context.env.outgoing;
    const originalWrite = outgoing.write;
    let destroyOutgoingOnClose = false;
    const client: LiveSseClient = {
      workspaceId: session.member.workspaceId,
      memberId: session.member.id,
      pendingNotification: null,
      readySent: false,
      hintCheckInFlight: false,
      hintQueued: false,
      cursorLagEntries: 0,
      cursorLagSince: null,
      close: () => {
        if (closed) return;
        closed = true;
        liveSseClients.delete(clientId);
        unsubscribe?.();
        restoreOutgoingWrite();
        finishStream();
        if (destroyOutgoingOnClose && !outgoing.destroyed && !outgoing.writableEnded) outgoing.destroy();
        if (stream && !stream.aborted && !stream.closed) stream.abort();
      },
    };
    const sendAuthorizedHint = async (): Promise<void> => {
      if (client.hintCheckInFlight || closed || !client.readySent || !stream) return;
      client.hintCheckInFlight = true;
      try {
        while (!closed && client.pendingNotification) {
          const notification = client.pendingNotification;
          client.pendingNotification = null;
          let entry: TimelineEntry | null = null;
          try {
            entry = await timelineStore?.getTimelineEntry(client.workspaceId, notification.entryId) ?? null;
          } catch {
            client.close();
            return;
          }
          if (!entry || entry.workspaceId !== client.workspaceId) continue;
          if (client.hintQueued) continue;
          client.hintQueued = true;
          await stream.writeSSE({ event: "timeline", data: JSON.stringify({ entryId: entry.id }) });
          if (stream.aborted) {
            client.close();
            return;
          }
          void refreshLiveClientLag(client);
          return;
        }
      } finally {
        client.hintCheckInFlight = false;
        if (!closed && client.pendingNotification && !client.hintQueued) void sendAuthorizedHint();
      }
    };
    client.sendPendingHint = () => { void sendAuthorizedHint(); };
    const onNotification = (notification: TimelineNotification): void => {
      if (closed) return;
      client.pendingNotification = notification;
      if (!client.hintQueued) void sendAuthorizedHint();
    };
    liveSseClients.set(clientId, client);
    const invokeOriginalWrite = originalWrite.bind(outgoing) as (chunk: string | Uint8Array, encoding?: BufferEncoding, callback?: () => void) => boolean;
    const guardedWrite = (chunk: string | Uint8Array, encoding?: BufferEncoding, callback?: () => void): boolean => {
      const accepted = invokeOriginalWrite(chunk, encoding, callback);
      if (!accepted) {
        destroyOutgoingOnClose = true;
        client.close();
      }
      return accepted;
    };
    outgoing.write = guardedWrite as typeof outgoing.write;
    restoreOutgoingWrite = (): void => {
      if (outgoing.write === guardedWrite) outgoing.write = originalWrite;
    };
    const abort = (): void => client.close();
    context.req.raw.signal.addEventListener("abort", abort, { once: true });
    try {
      unsubscribe = await timelineNotifications.subscribeTimeline(onNotification);
      if (closed) {
        unsubscribe();
        return context.body(null, 204);
      }
      if (timelineNotifications.timelineNotificationsHealthy?.() === false) throw new Error("Timeline notifications are not healthy");
    } catch {
      timelineReady = false;
      client.close();
      return json(context, 503, { error: "timeline_notifications_unavailable" });
    }
    timelineReady = true;
    context.header("cache-control", "no-store");
    context.header("connection", "keep-alive");
    context.header("x-accel-buffering", "no");
    const response = streamSSE(context, async (nextStream) => {
      stream = nextStream;
      nextStream.onAbort(client.close);
      await nextStream.writeSSE({ event: "ready", data: JSON.stringify({ clientId }) });
      if (nextStream.aborted) {
        client.close();
        return;
      }
      client.readySent = true;
      void sendAuthorizedHint();
      // The ready marker is emitted only after LISTEN is active; the browser now recovers durably.
      await new Promise<void>((resolve) => {
        finishStream = resolve;
        if (closed) resolve();
      });
    });
    response.headers.set("content-type", "text/event-stream; charset=utf-8");
    return response;
  };
  const timelineApi = async (context: AppContext): Promise<Response> => {
    const session = await requireTimeline(context);
    if (session instanceof Response) return session;
    if (!timelineStore) return json(context, 503, { error: "timeline_store_unavailable" });
    try {
      const query = parseTimelineQuery(timelineQueryInput(context.req.query()));
      const page = await timelineStore.listTimelineEntries(session.member.workspaceId, query, session.member.id);
      const sseClientId = context.req.query("sseClientId");
      const liveClient = sseClientId ? liveSseClients.get(sseClientId) : undefined;
      if (liveClient && liveClient.workspaceId === session.member.workspaceId && liveClient.memberId === session.member.id) {
        const cursor = page.nextCursor ?? page.resumeCursor ?? query.cursor;
        liveClient.query = cursor ? { ...query, cursor } : { ...query };
        liveClient.hintQueued = false;
        const pendingNotification = liveClient.pendingNotification;
        liveClient.pendingNotification = null;
        if (pendingNotification) {
          liveClient.pendingNotification = pendingNotification;
          liveClient.sendPendingHint?.();
        }
        void refreshLiveClientLag(liveClient);
      }
      return json(context, 200, page);
    } catch (error: unknown) {
      if (error instanceof TimelineQueryValidationError) return json(context, 400, { error: "invalid_timeline_query", issues: error.issues });
      throw error;
    }
  };
  const timelineReviewApi = async (context: AppContext): Promise<Response> => {
    const session = await requireTimeline(context);
    if (session instanceof Response) return session;
    if (!timelineStore?.reviewAttentionItem) return json(context, 503, { error: "attention_store_unavailable" });
    const entryId = context.req.param("entryId") ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entryId)) return json(context, 400, { error: "invalid_attention_review" });
    const result = await timelineStore.reviewAttentionItem(session.member.workspaceId, session.member.id, entryId);
    return result ? json(context, 200, result) : json(context, 404, { error: "attention_item_not_found" });
  };

  const retentionApi = async (context: AppContext): Promise<Response> => {
    const session = await requireWorkspace(context);
    if (session instanceof Response) return session;
    if (!retentionStore) return json(context, 503, { error: "retention_store_unavailable" });
    const isCleanup = context.req.path === "/api/retention/cleanup" || context.req.path === "/api/retention/run";
    if (!isCleanup && context.req.method === "GET") return json(context, 200, { policy: await retentionStore.getRetentionPolicy(session.member.workspaceId) });
    if (!hasRetentionManagement(session.member)) return json(context, 403, { error: "missing_capability", capability: capabilities.retentionManage });
    try {
      if (isCleanup) return json(context, 200, { result: await runRetentionCleanup(session.member, retentionStore) });
      return json(context, 200, { policy: await updateRetentionPolicy(session.member, retentionStore, await parseRetentionRequest(context.req.raw)) });
    } catch (error: unknown) {
      if (error instanceof RetentionValidationError) return json(context, 400, { error: "invalid_retention_policy", issues: error.issues });
      throw error;
    }
  };
  const correlationApi = async (context: AppContext): Promise<Response> => {
    const session = await requireTimeline(context);
    if (session instanceof Response) return session;
    if (!hasCorrelationStore(timelineStore)) return json(context, 503, { error: "correlation_store_unavailable" });
    const suggestionId = context.req.param("suggestionId");
    if (context.req.method === "GET") {
      if (suggestionId) {
        const suggestion = await timelineStore.getCorrelationSuggestion(session.member.workspaceId, suggestionId);
        return suggestion ? json(context, 200, { suggestion }) : json(context, 404, { error: "correlation_suggestion_not_found" });
      }
      return json(context, 200, { suggestions: await timelineStore.listCorrelationSuggestions(session.member.workspaceId) });
    }
    if (!hasCorrelationReview(session.member)) return json(context, 403, { error: "missing_capability", capability: capabilities.correlationReview });
    const decision = context.req.param("decision");
    if (!suggestionId || (decision !== "confirm" && decision !== "reject")) return json(context, 400, { error: "invalid_correlation_suggestion" });
    try {
      const result = decision === "confirm"
        ? await confirmCorrelationSuggestion(session.member, timelineStore, suggestionId)
        : await rejectCorrelationSuggestion(session.member, timelineStore, suggestionId);
      return result ? json(context, 200, result) : json(context, 404, { error: "correlation_suggestion_not_found" });
    } catch (error: unknown) {
      if (error instanceof CorrelationDecisionConflictError) return json(context, 409, { error: "correlation_suggestion_already_decided", status: error.status });
      throw error;
    }
  };
  const experimentApi = async (context: AppContext): Promise<Response> => {
    const session = await requireTimeline(context);
    if (session instanceof Response) return session;
    if (!experimentStore) return json(context, 503, { error: "experiment_store_unavailable" });
    const experimentId = context.req.param("experimentId");
    if (context.req.method === "GET") {
      if (experimentId) {
        const experiment = await experimentStore.getExperiment(session.member.workspaceId, experimentId);
        return experiment ? json(context, 200, { experiment }) : json(context, 404, { error: "experiment_not_found" });
      }
      return json(context, 200, { experiments: await experimentStore.listExperiments(session.member.workspaceId) });
    }
    const creating = !experimentId && context.req.method === "POST";
    const updating = Boolean(experimentId) && (context.req.method === "PATCH" || context.req.method === "PUT");
    if (!creating && !updating) return json(context, 405, { error: "method_not_allowed" });
    if (!hasExperimentWrite(session.member)) return json(context, 403, { error: "missing_capability", capability: capabilities.experimentWrite });
    try {
      if (creating) return json(context, 201, { experiment: await experimentStore.createExperiment(session.member.workspaceId, session.member.id, await parseExperimentRequest(context.req.raw)) });
      const experiment = await experimentStore.updateExperiment(session.member.workspaceId, experimentId ?? "", await parseExperimentRequest(context.req.raw));
      return experiment ? json(context, 200, { experiment }) : json(context, 404, { error: "experiment_not_found" });
    } catch (error: unknown) {
      if (error instanceof ExperimentValidationError) return json(context, 400, { error: "invalid_experiment", issues: error.issues });
      if (error instanceof ExperimentLifecycleError) return json(context, 409, { error: "invalid_experiment_lifecycle", from: error.from, to: error.to });
      throw error;
    }
  };
  const logApi = async (context: AppContext): Promise<Response> => {
    context.header("cache-control", "no-store");
    const session = await requireWorkspace(context);
    if (session instanceof Response) return session;
    if (!hasLogReadCapability(session.member)) return json(context, 403, { error: "missing_capability", capability: capabilities.logsRead });
    if (!logAuditStore) return json(context, 503, { error: "recent_log_window_unavailable" });
    let input: unknown;
    try {
      input = JSON.parse(await requestText(context)) as unknown;
    } catch {
      return json(context, 400, { error: "invalid_json" });
    }
    try {
      const recentLogs = await requestRecentLogWindow({ member: session.member, scope: await scopeForSession(session), input, adapter: logAdapter, auditStore: logAuditStore, telemetry: recentLogTelemetry(context.get("requestSpan").correlation) });
      return json(context, 200, { window: recentLogs });
    } catch (error: unknown) {
      if (error instanceof RecentLogWindowValidationError) return json(context, 400, { error: "invalid_recent_log_window", issues: error.issues });
      return json(context, 503, { error: "recent_log_window_unavailable" });
    }
  };

  const htmlUnauthenticated = (context: AppContext, lookup: RequestSession, language: Language): Response => lookup.rejection
    ? html(context, 403, renderRejectionPage(language, lookup.rejection))
    : redirect(context, `/?lang=${language}`, 302);
  const logPage = async (context: AppContext): Promise<Response> => {
    context.header("cache-control", "no-store");
    const language = languageFor(context);
    const lookup = await workspaceSession(context);
    if (!lookup.session) return htmlUnauthenticated(context, lookup, language);
    const scope = await scopeForSession(lookup.session);
    const messages = messagesFor(language);
    if (!hasLogReadCapability(lookup.session.member)) return html(context, 403, renderApplicationPage(language, lookup.session, scope, { logError: messages.logsReadDenied }));
    if (!logAuditStore) return html(context, 503, renderApplicationPage(language, lookup.session, scope, { logError: messages.recentLogsUnavailable }));
    const fields = await requestForm(context);
    if (!fields) return html(context, 400, renderApplicationPage(language, lookup.session, scope, { logError: messages.recentLogsInvalid }));
    try {
      const recentLogs = await requestRecentLogWindow({ member: lookup.session.member, scope, input: formLogInput(new URLSearchParams(Object.entries(fields))), adapter: logAdapter, auditStore: logAuditStore, telemetry: recentLogTelemetry(context.get("requestSpan").correlation) });
      return html(context, 200, renderApplicationPage(language, lookup.session, scope, { logResult: recentLogs }));
    } catch (error: unknown) {
      return html(context, error instanceof RecentLogWindowValidationError ? 400 : 503, renderApplicationPage(language, lookup.session, scope, { logError: error instanceof RecentLogWindowValidationError ? messages.recentLogsInvalid : messages.recentLogsUnavailable }));
    }
  };
  const timelineReviewPage = async (context: AppContext): Promise<Response> => {
    const language = languageFor(context);
    const lookup = await workspaceSession(context);
    if (!lookup.session) return htmlUnauthenticated(context, lookup, language);
    const scope = await scopeForSession(lookup.session);
    const messages = messagesFor(language);
    if (!hasTimelineAccess(lookup.session)) return html(context, 403, renderApplicationPage(language, lookup.session, scope, { error: messages.attentionReviewInvalid }));
    if (!timelineStore?.reviewAttentionItem) return html(context, 503, renderApplicationPage(language, lookup.session, scope, { error: messages.attentionReviewUnavailable }));
    const entryId = context.req.param("entryId") ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entryId)) return html(context, 400, renderApplicationPage(language, lookup.session, scope, { error: messages.attentionReviewInvalid }));
    const result = await timelineStore.reviewAttentionItem(lookup.session.member.workspaceId, lookup.session.member.id, entryId);
    return result ? redirect(context, `/app?lang=${language}&attention=reviewed`) : html(context, 404, renderApplicationPage(language, lookup.session, scope, { error: messages.attentionNotFound }));
  };
  const correlationPage = async (context: AppContext): Promise<Response> => {
    const language = languageFor(context);
    const lookup = await workspaceSession(context);
    if (!lookup.session) return htmlUnauthenticated(context, lookup, language);
    const messages = messagesFor(language);
    const scope = await scopeForSession(lookup.session);
    if (!hasTimelineAccess(lookup.session) || !hasCorrelationStore(timelineStore)) return html(context, 403, renderApplicationPage(language, lookup.session, scope, { error: messages.correlationReviewDenied }));
    if (!hasCorrelationReview(lookup.session.member)) return html(context, 403, renderApplicationPage(language, lookup.session, scope, { error: messages.correlationReviewDenied }, [], [], undefined, [], await correlationSuggestionsForSession(lookup.session)));
    const suggestionId = context.req.param("suggestionId") ?? "";
    const decision = context.req.param("decision");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(suggestionId) || (decision !== "confirm" && decision !== "reject")) return html(context, 400, renderApplicationPage(language, lookup.session, scope, { error: messages.noCorrelationSuggestions }));
    try {
      const result = decision === "confirm" ? await confirmCorrelationSuggestion(lookup.session.member, timelineStore, suggestionId) : await rejectCorrelationSuggestion(lookup.session.member, timelineStore, suggestionId);
      return result ? redirect(context, `/app?lang=${language}&correlation=${result.suggestion.status}`) : html(context, 404, renderApplicationPage(language, lookup.session, scope, { error: messages.noCorrelationSuggestions }));
    } catch (error: unknown) {
      if (error instanceof CorrelationDecisionConflictError) return html(context, 409, renderApplicationPage(language, lookup.session, scope, { correlationError: messages.correlationDecisionConflict }));
      throw error;
    }
  };
  const experimentPage = async (context: AppContext): Promise<Response> => {
    const language = languageFor(context);
    const lookup = await workspaceSession(context);
    if (!lookup.session) return htmlUnauthenticated(context, lookup, language);
    if (!hasWorkspaceAccess(lookup.session)) return html(context, 403, renderRejectionPage(language, "admission_required"));
    const messages = messagesFor(language);
    if (!experimentStore) return html(context, 503, renderApplicationPage(language, lookup.session, await scopeForSession(lookup.session), { experimentError: messages.experimentUnavailable }));
    const experimentId = context.req.param("experimentId");
    const experiments = await experimentStore.listExperiments(lookup.session.member.workspaceId);
    const suggestions = hasTimelineAccess(lookup.session) ? await correlationSuggestionsForSession(lookup.session) : [];
    if (context.req.method === "GET") {
      if (experimentId && !experiments.some((experiment) => experiment.id === experimentId)) return html(context, 404, renderApplicationPage(language, lookup.session, await scopeForSession(lookup.session), { experimentError: messages.experimentUnavailable }, [], experiments));
      const timelineEntries = timelineStore && hasTimelineAccess(lookup.session) ? (await timelineStore.listTimelineEntries(lookup.session.member.workspaceId, { limit: 100 })).entries : [];
      return html(context, 200, renderApplicationPage(language, lookup.session, await scopeForSession(lookup.session), undefined, timelineEntries, experiments, undefined, [], suggestions));
    }
    if ((!experimentId && context.req.path !== "/experiments") || (experimentId && context.req.method !== "POST")) return html(context, 405, renderApplicationPage(language, lookup.session, await scopeForSession(lookup.session), { experimentError: messages.experimentUnavailable }, [], experiments));
    if (!hasExperimentWrite(lookup.session.member)) return html(context, 403, renderApplicationPage(language, lookup.session, await scopeForSession(lookup.session), { experimentError: messages.experimentWriteDenied }, [], experiments));
    try {
      if (!experimentId) await experimentStore.createExperiment(lookup.session.member.workspaceId, lookup.session.member.id, await parseExperimentRequest(context.req.raw));
      else {
        const updated = await experimentStore.updateExperiment(lookup.session.member.workspaceId, experimentId, await parseExperimentRequest(context.req.raw));
        if (!updated) return html(context, 404, renderApplicationPage(language, lookup.session, await scopeForSession(lookup.session), { experimentError: messages.experimentUnavailable }, [], experiments));
      }
      return redirect(context, `/app?lang=${language}&experiment=${experimentId ? "updated" : "created"}`);
    } catch (error: unknown) {
      const message = error instanceof ExperimentValidationError || error instanceof ExperimentLifecycleError ? `${messages.experimentInvalid} ${error.message}` : messages.experimentUnavailable;
      const latest = await experimentStore.listExperiments(lookup.session.member.workspaceId);
      return html(context, error instanceof ExperimentLifecycleError ? 409 : 400, renderApplicationPage(language, lookup.session, await scopeForSession(lookup.session), { experimentError: message }, [], latest));
    }
  };
  const retentionPage = async (context: AppContext): Promise<Response> => {
    const language = languageFor(context);
    const lookup = await workspaceSession(context);
    if (!lookup.session) return htmlUnauthenticated(context, lookup, language);
    const scope = await scopeForSession(lookup.session);
    const policy = await retentionPolicyForSession(lookup.session);
    const messages = messagesFor(language);
    if (!retentionStore) return html(context, 503, renderApplicationPage(language, lookup.session, scope, { retentionError: messages.retentionUnavailable }, [], [], undefined, [], [], policy));
    if (!hasRetentionManagement(lookup.session.member)) return html(context, 403, renderApplicationPage(language, lookup.session, scope, { retentionError: messages.retentionManageDenied }, [], [], undefined, [], [], policy));
    try {
      if (context.req.path === "/retention/cleanup") {
        const result = await runRetentionCleanup(lookup.session.member, retentionStore);
        const cleanupQuery = new URLSearchParams({ lang: language, retention: "cleanup", eligible: String(result.eligibleObservations), protected: String(result.protectedObservations), deleted: String(result.deletedObservations), entries: String(result.deletedTimelineEntries), failures: String(result.failures) });
        return redirect(context, `/app?${cleanupQuery.toString()}`);
      }
      const fields = await requestForm(context);
      if (!fields) throw new RetentionValidationError([{ field: "retentionDays", message: "must be a valid request" }]);
      await updateRetentionPolicy(lookup.session.member, retentionStore, fields);
      return redirect(context, `/app?lang=${language}&retention=updated`);
    } catch (error: unknown) {
      return html(context, error instanceof RetentionValidationError ? 400 : 503, renderApplicationPage(language, lookup.session, scope, { retentionError: error instanceof RetentionValidationError ? messages.retentionInvalid : messages.retentionUnavailable }, [], [], undefined, [], [], policy));
    }
  };
  const clusterApi = async (context: AppContext): Promise<Response> => {
    const session = await requireWorkspace(context);
    if (session instanceof Response) return session;
    if (context.req.method === "GET") return json(context, 200, { scope: await scopeForSession(session) });
    if (!hasClusterConfigureCapability(session.member)) return json(context, 403, { error: "missing_capability", capability: capabilities.clusterConfigure });
    const input = await requestJson(context);
    if (input === null) return json(context, 400, { error: "invalid_json" });
    try {
      return json(context, 200, { scope: await configureClusterScope(session.member, clusterScopeStore, input) });
    } catch (error: unknown) {
      if (error instanceof ClusterScopeValidationError) return json(context, 400, { error: "invalid_cluster_scope", issues: error.issues });
      throw error;
    }
  };
  const clusterPage = async (context: AppContext): Promise<Response> => {
    const language = languageFor(context);
    const lookup = await workspaceSession(context);
    if (!lookup.session) return htmlUnauthenticated(context, lookup, language);
    const scope = await scopeForSession(lookup.session);
    const messages = messagesFor(language);
    if (!hasClusterConfigureCapability(lookup.session.member)) return html(context, 403, renderApplicationPage(language, lookup.session, scope, { error: messages.clusterConfigurationDenied }));
    try {
      await configureClusterScope(lookup.session.member, clusterScopeStore, formScopeInput(new URLSearchParams(await requestText(context))));
      return redirect(context, `/app?lang=${language}&cluster=saved`);
    } catch (error: unknown) {
      const errorMessage = error instanceof ClusterScopeValidationError ? `${messages.clusterConfigurationInvalid} ${error.issues.map((issue) => issue.message).join(" ")}` : messages.clusterConfigurationUnavailable;
      return html(context, 400, renderApplicationPage(language, lookup.session, scope, { error: errorMessage }));
    }
  };

  const membershipApiSession = async (context: AppContext): Promise<{ session: AuthenticatedSession; store: AdmissionStore & MembershipStore } | Response> => {
    const lookup = await workspaceSession(context);
    if (!lookup.session) return json(context, 401, { error: lookup.rejection ?? "unauthorized" });
    if (!hasWorkspaceAccess(lookup.session) || !hasCapability(lookup.session.member, capabilities.membershipManage)) return json(context, 403, { error: "forbidden", capability: capabilities.membershipManage });
    if (!membershipStore) return json(context, 503, { error: "membership_store_unavailable" });
    return { session: lookup.session, store: membershipStore };
  };
  const membersApi = async (context: AppContext): Promise<Response> => {
    const result = await membershipApiSession(context);
    if (result instanceof Response) return result;
    return json(context, 200, { members: await result.store.listMembers() });
  };
  const invitationsApi = async (context: AppContext): Promise<Response> => {
    const result = await membershipApiSession(context);
    if (result instanceof Response) return result;
    return json(context, 200, { invitations: await result.store.listInvitations() });
  };
  const auditApi = async (context: AppContext): Promise<Response> => {
    const result = await membershipApiSession(context);
    if (result instanceof Response) return result;
    return json(context, 200, { records: await result.store.listAuditRecords() });
  };
  const inviteApi = async (context: AppContext): Promise<Response> => {
    const result = await membershipApiSession(context);
    if (result instanceof Response) return result;
    const fields = await requestForm(context);
    if (!fields?.email) return json(context, 400, { error: "invalid_request" });
    try {
      return json(context, 201, { invitation: await result.store.createInvitation(fields.email, result.session.member) });
    } catch (error) {
      return json(context, 400, { error: error instanceof Error ? error.message : "membership operation failed" });
    }
  };
  const revokeInvitationApi = async (context: AppContext): Promise<Response> => {
    const result = await membershipApiSession(context);
    if (result instanceof Response) return result;
    try {
      const invitation = await result.store.revokeInvitation(context.req.param("invitationId") ?? "", result.session.member);
      return invitation ? json(context, 200, { invitation }) : json(context, 404, { error: "invitation_not_found_or_unusable" });
    } catch (error) {
      const rootError = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      if (rootError instanceof LastWorkspaceOwnerError) return json(context, 409, { error: "last_workspace_owner" });
      return json(context, 400, { error: error instanceof Error ? error.message : "membership operation failed" });
    }
  };
  const roleApi = async (context: AppContext): Promise<Response> => {
    const result = await membershipApiSession(context);
    if (result instanceof Response) return result;
    const fields = await requestForm(context);
    if (!fields?.role || !isRole(fields.role)) return json(context, 400, { error: "invalid_role" });
    try {
      const member = await result.store.assignMemberRole(context.req.param("memberId") ?? "", fields.role, result.session.member);
      return member ? json(context, 200, { member }) : json(context, 404, { error: "member_not_found" });
    } catch (error) {
      const rootError = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      if (rootError instanceof LastWorkspaceOwnerError) return json(context, 409, { error: "last_workspace_owner" });
      return json(context, 400, { error: error instanceof Error ? error.message : "membership operation failed" });
    }
  };
  const membersPage = async (context: AppContext): Promise<Response> => {
    const language = languageFor(context);
    const lookup = await workspaceSession(context);
    if (!lookup.session) return redirect(context, `/?lang=${language}`, 302);
    if (!hasWorkspaceAccess(lookup.session) || !hasCapability(lookup.session.member, capabilities.membershipManage)) return html(context, 403, renderMembershipDeniedPage(language));
    if (!membershipStore) return json(context, 503, { error: "membership_store_unavailable" });
    const query = context.req.query();
    const notice = query.notice;
    const messages = messagesFor(language);
    const noticeText = notice === "created" ? messages.invitationCreated : notice === "revoked" ? messages.invitationRevoked : notice === "role" ? messages.roleChanged : undefined;
    return html(context, 200, renderMembersPage(language, lookup.session, await membershipStore.listMembers(), await membershipStore.listInvitations(), noticeText));
  };
  const membershipForm = async (context: AppContext, operation: "invite" | "revoke" | "role"): Promise<Response> => {
    const language = languageFor(context);
    const lookup = await workspaceSession(context);
    if (!lookup.session) return redirect(context, `/?lang=${language}`, 302);
    if (!hasWorkspaceAccess(lookup.session) || !hasCapability(lookup.session.member, capabilities.membershipManage)) return html(context, 403, renderMembershipDeniedPage(language));
    if (!membershipStore) return html(context, 503, renderMembershipDeniedPage(language));
    const fields = await requestForm(context);
    const responseLanguage = fields?.lang ? parseLanguage(fields.lang) : language;
    try {
      if (operation === "invite" && fields?.email) await membershipStore.createInvitation(fields.email, lookup.session.member);
      else if (operation === "revoke" && fields?.invitationId && await membershipStore.revokeInvitation(fields.invitationId, lookup.session.member)) return redirect(context, `/members?lang=${responseLanguage}&notice=revoked`);
      else if (operation === "role" && fields?.memberId && fields.role && isRole(fields.role) && await membershipStore.assignMemberRole(fields.memberId, fields.role, lookup.session.member)) return redirect(context, `/members?lang=${responseLanguage}&notice=role`);
      else throw new Error("membership operation failed");
      return redirect(context, `/members?lang=${responseLanguage}&notice=created`);
    } catch {
      return html(context, 400, renderMembershipDeniedPage(responseLanguage));
    }
  };

  const operational = async (context: AppContext): Promise<Response> => {
    const path = context.req.path;
    if (path === "/metrics") {
      await status();
      syncWebMetrics();
      return context.text(telemetry.metricsText(), 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
    }
    if (path === "/health/live") return json(context, 200, { service: "tracegarden-web", status: stopping ? "stopping" : "alive", liveness: stopping ? "stopping" : "alive" });
    const current = await status();
    const healthy: boolean = path === "/health/startup" ? current.startup === "ready" : current.readiness === "ready";
    const statusCode: 200 | 503 = healthy ? 200 : 503;
    return json(context, statusCode, path === "/health/startup" ? { ...current, status: healthy ? "ready" : "not-ready" } : current);
  };
  const sessionApi = async (context: AppContext): Promise<Response> => {
    const session = await requireWorkspace(context);
    return session instanceof Response ? session : json(context, 200, { member: session.member });
  };
  const workspacePage = async (context: AppContext): Promise<Response> => {
    const language = languageFor(context);
    const lookup = await workspaceSession(context);
    if (!lookup.session) return htmlUnauthenticated(context, lookup, language);
    if (!hasWorkspaceAccess(lookup.session)) return html(context, 403, renderRejectionPage(language, "admission_required"));
    const query = context.req.query();
    let timelineQuery: TimelineQuery;
    try {
      timelineQuery = parseTimelineQuery(timelineQueryInput(query, true));
    } catch (error: unknown) {
      if (!(error instanceof TimelineQueryValidationError)) throw error;
      return html(context, 400, renderApplicationPage(language, lookup.session, await scopeForSession(lookup.session), { error: messagesFor(language).timelineInvalid }));
    }
    let timelinePage: TimelinePage;
    try {
      timelinePage = timelineStore && hasTimelineAccess(lookup.session) ? await timelineStore.listTimelineEntries(lookup.session.member.workspaceId, timelineQuery, lookup.session.member.id) : { entries: [], nextCursor: null };
    } catch (error: unknown) {
      if (!(error instanceof TimelineQueryValidationError)) throw error;
      return html(context, 400, renderApplicationPage(language, lookup.session, await scopeForSession(lookup.session), { error: messagesFor(language).timelineInvalid }));
    }
    const experiments = experimentStore && hasTimelineAccess(lookup.session) ? await experimentStore.listExperiments(lookup.session.member.workspaceId) : [];
    const suggestions = hasTimelineAccess(lookup.session) ? await correlationSuggestionsForSession(lookup.session) : [];
    const retentionPolicy = await retentionPolicyForSession(lookup.session);
    const cleanupResult = retentionCleanupQueryResult(query, retentionPolicy);
    const experimentNotice = query.experiment;
    return html(context, 200, renderApplicationPage(language, lookup.session, await scopeForSession(lookup.session), {
      saved: query.cluster === "saved",
      attentionReviewed: query.attention === "reviewed",
      ...(experimentNotice === "created" ? { experimentSaved: "created" as const } : {}),
      ...(experimentNotice === "updated" ? { experimentSaved: "updated" as const } : {}),
      ...(query.correlation === "confirmed" ? { correlationDecision: "confirmed" as const } : {}),
      ...(query.correlation === "rejected" ? { correlationDecision: "rejected" as const } : {}),
      ...(query.retention === "updated" ? { retentionSaved: true } : {}),
      ...(cleanupResult === undefined ? {} : { retentionResult: cleanupResult }),
    }, timelinePage.entries, timelinePage, timelineQuery, experiments, suggestions, retentionPolicy));
  };
  const rootPage = async (context: AppContext): Promise<Response> => {
    const current = await status();
    const language = languageFor(context);
    const lookup = await workspaceSession(context);
    if (lookup.rejection) return html(context, 403, renderRejectionPage(language, lookup.rejection));
    if (lookup.session) {
      if (!hasWorkspaceAccess(lookup.session)) return html(context, 403, renderRejectionPage(language, "admission_required"));
      const page = await workspacePage(context);
      if (current.status === "ready" || page.status !== 200) return page;
      return context.newResponse(page.body, { status: 503, headers: page.headers });
    }
    if (cloudflareAccess) return json(context, 401, { error: "cloudflare_access_jwt_required" });
    return html(context, current.status === "ready" ? 200 : 503, renderLoginPage(language, current.checks.database === "ready", identityAdapter));
  };

  const app = new Hono<WebContext>();
  app.onError((error, context) => {
    const correlation = context.get("correlation");
    telemetry.log("error", "web.request.failure", correlation, { error_type: error instanceof Error ? error.name : "unknown", status_code: 503 });
    context.get("requestSpan").fail(error);
    return context.json({ error: "service_unavailable" }, 503);
  });
  app.use("*", async (context, next) => {
    const correlation = telemetry.correlation();
    const requestSpan = telemetry.startSpan("http.request", correlation, { method: context.req.method, path: context.req.path });
    context.set("correlation", correlation);
    context.set("requestSpan", requestSpan);
    context.header("x-request-id", requestSpan.correlation.requestId);
    context.header("x-trace-id", requestSpan.correlation.traceId);
    context.header("traceparent", `00-${requestSpan.correlation.traceId}-${requestSpan.correlation.spanId}-01`);
    try {
      await next();
    } catch (error: unknown) {
      telemetry.log("error", "web.request.failure", correlation, { error_type: error instanceof Error ? error.name : "unknown", status_code: 503 });
      requestSpan.fail(error);
      return context.json({ error: "service_unavailable" }, 503);
    } finally {
      requestSpan.end({ status_code: context.res.status });
    }
  });

  app.get("/api/auth/*", betterAuth);
  app.post("/api/auth/*", betterAuth);
  app.put("/api/auth/*", betterAuth);
  app.patch("/api/auth/*", betterAuth);
  app.delete("/api/auth/*", betterAuth);
  app.options("/api/auth/*", betterAuth);
  app.get("/auth/login", login);
  app.get("/login", login);
  app.post("/auth/login", login);
  app.post("/login", login);
  app.post("/auth/logout", logout);
  app.get("/auth/google", googleLogin);
  app.get("/api/timeline/stream", timelineStream);
  app.get("/api/timeline", timelineApi);
  app.get("/api/timeline/entries", timelineApi);
  app.post("/api/timeline/entries/:entryId/review", timelineReviewApi);
  app.get("/api/retention", retentionApi);
  app.get("/api/retention/policy", retentionApi);
  app.post("/api/retention", retentionApi);
  app.put("/api/retention", retentionApi);
  app.patch("/api/retention", retentionApi);
  app.post("/api/retention/policy", retentionApi);
  app.put("/api/retention/policy", retentionApi);
  app.patch("/api/retention/policy", retentionApi);
  app.post("/api/retention/cleanup", retentionApi);
  app.post("/api/retention/run", retentionApi);
  app.get("/api/correlations/suggestions", correlationApi);
  app.get("/api/correlations/suggestions/:suggestionId", correlationApi);
  app.post("/api/correlations/suggestions/:suggestionId/:decision", correlationApi);
  app.get("/api/experiments", experimentApi);
  app.get("/api/experiments/:experimentId", experimentApi);
  app.post("/api/experiments", experimentApi);
  app.patch("/api/experiments/:experimentId", experimentApi);
  app.put("/api/experiments/:experimentId", experimentApi);
  app.post("/api/logs/recent", logApi);
  app.post("/logs/recent", logPage);
  app.post("/timeline/entries/:entryId/review", timelineReviewPage);
  app.post("/correlations/suggestions/:suggestionId/:decision", correlationPage);
  app.get("/experiments", experimentPage);
  app.get("/experiments/:experimentId", experimentPage);
  app.post("/experiments", experimentPage);
  app.post("/experiments/:experimentId", experimentPage);
  app.post("/retention/update", retentionPage);
  app.post("/retention/cleanup", retentionPage);
  app.get("/api/cluster", clusterApi);
  app.get("/api/cluster/scope", clusterApi);
  app.post("/api/cluster", clusterApi);
  app.put("/api/cluster", clusterApi);
  app.post("/api/cluster/scope", clusterApi);
  app.put("/api/cluster/scope", clusterApi);
  app.post("/cluster/configure", clusterPage);
  app.get("/members", membersPage);
  app.get("/api/members", membersApi);
  app.get("/api/invitations", invitationsApi);
  app.get("/api/audit", auditApi);
  app.post("/api/invitations", inviteApi);
  app.delete("/api/invitations/:invitationId", revokeInvitationApi);
  app.post("/api/invitations/:invitationId/revoke", revokeInvitationApi);
  app.patch("/api/members/:memberId/role", roleApi);
  app.post("/api/members/:memberId/role", roleApi);
  app.post("/members/invite", (context) => membershipForm(context, "invite"));
  app.post("/members/revoke", (context) => membershipForm(context, "revoke"));
  app.post("/members/role", (context) => membershipForm(context, "role"));
  app.get("/metrics", operational);
  app.get("/health/live", operational);
  app.get("/health/startup", operational);
  app.get("/health/readiness", operational);
  app.get("/api/status", operational);
  app.get("/api/session", sessionApi);
  app.get("/app", workspacePage);
  app.get("/timeline", workspacePage);
  app.get("/", rootPage);
  const methodNotAllowed = (context: AppContext): Response => json(context, 405, { error: "method_not_allowed" });
  app.post("*", methodNotAllowed);
  app.put("*", methodNotAllowed);
  app.patch("*", methodNotAllowed);
  app.delete("*", methodNotAllowed);
  app.options("*", methodNotAllowed);
  app.notFound((context) => context.json({ error: "not_found" }, 404));

  const server = createServer(getRequestListener((request, bindings) => app.fetch(request, bindings)));
  const port = options.port ?? Number(environment.PORT ?? "3000");
  const host = options.host ?? environment.HOST ?? "127.0.0.1";
  const drainServer = (): Promise<void> => new Promise((resolve, reject) => {
    try {
      server.close((error?: Error) => error ? reject(error) : resolve());
    } catch (error) {
      reject(error);
    }
  });
  try {
    await listenForStartup(server, port, host);
  } catch (error) {
    startupState = "failed";
    telemetry.log("error", "web.startup.failure", startupCorrelation, {
      error_type: error instanceof Error ? error.name : "unknown",
    });
    try {
      removeTimelineErrorListener?.();
    } catch {
      // Cleanup cannot mask the bind failure.
    }
    try {
      releaseTimelineReadiness?.();
    } catch {
      // Cleanup cannot mask the bind failure.
    }
    releaseTimelineReadiness = undefined;
    try {
      await database.close();
    } catch {
      // Cleanup cannot mask the bind failure.
    }
    throw error;
  }
  startupState = "ready";
  telemetry.log("info", "web.started", startupCorrelation, { host, port });
  syncWebMetrics();
  return {
    server,
    status,
    telemetry,
    close: async () => {
      stopping = true;
      databaseReady = false;
      migrationReady = false;
      timelineReady = false;
      telemetry.log("info", "web.stopping", startupCorrelation);
      try {
        try {
          removeTimelineErrorListener?.();
          for (const client of [...liveSseClients.values()]) client.close();
          releaseTimelineReadiness?.();
          releaseTimelineReadiness = undefined;
        } finally {
          await drainServer();
        }
      } finally {
        await database.close();
      }
    },
  };
}
