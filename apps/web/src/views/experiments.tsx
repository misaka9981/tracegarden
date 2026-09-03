import { hasExperimentWrite, type ConfirmedLinkRecord, type ExperimentRecord } from "../../../../packages/domain/src/index.js";
import { type AuthenticatedSession } from "../../../../packages/identity/src/index.js";
import { type Language, type Messages } from "../../../../packages/i18n/src/index.js";

export type ExperimentFeedback = Readonly<{ saved?: "created" | "updated" | undefined; error?: string | undefined }>;

export function experimentStateLabel(messages: Messages, state: ExperimentRecord["state"]): string {
  return state === "draft" ? messages.experimentDraft
    : state === "active" ? messages.experimentActive
      : state === "concluded" ? messages.experimentConcluded
        : messages.experimentAbandoned;
}

function workloadText(workload: ExperimentRecord["workloads"][number]): string {
  return `${workload.clusterId} | ${workload.namespace} | ${workload.kind} | ${workload.name}`;
}

export function ExperimentForm({ language, messages, experiment }: { language: Language; messages: Messages; experiment?: ExperimentRecord }) {
  const id = experiment ? `-${experiment.id}` : "";
  const action = experiment ? `/experiments/${encodeURIComponent(experiment.id)}` : "/experiments";
  return <form method="post" action={`${action}?lang=${language}`} data-experiment-form={experiment?.id}>
    <input type="hidden" name="lang" value={language} />
    {experiment ? <input type="hidden" name="experimentId" value={experiment.id} /> : null}
    <label for={`experiment-hypothesis${id}`}>{messages.hypothesis}</label>
    <textarea id={`experiment-hypothesis${id}`} name="hypothesis" rows={3} required>{experiment?.hypothesis ?? ""}</textarea>
    <label for={`experiment-change${id}`}>{messages.change}</label>
    <textarea id={`experiment-change${id}`} name="change" rows={3} required>{experiment?.change ?? ""}</textarea>
    <label for={`experiment-observation${id}`}>{messages.observation}</label>
    <textarea id={`experiment-observation${id}`} name="observation" rows={3} required>{experiment?.observation ?? ""}</textarea>
    <label for={`experiment-conclusion${id}`}>{messages.conclusion}</label>
    <textarea id={`experiment-conclusion${id}`} name="conclusion" rows={3}>{experiment?.conclusion ?? ""}</textarea>
    <label for={`experiment-state${id}`}>{messages.lifecycleState}</label>
    <select id={`experiment-state${id}`} name="state">
      {(["draft", "active", "concluded", "abandoned"] as const).map((state) => <option value={state} selected={state === (experiment?.state ?? "draft")}>{experimentStateLabel(messages, state)}</option>)}
    </select>
    <label for={`experiment-tags${id}`}>{messages.tags}</label>
    <textarea id={`experiment-tags${id}`} name="tags" rows={2}>{experiment?.tags.join("\n") ?? ""}</textarea>
    <label for={`experiment-workloads${id}`}>{messages.workloads}</label>
    <textarea id={`experiment-workloads${id}`} name="workloads" rows={2} placeholder={messages.workloadFormat}>{experiment?.workloads.map(workloadText).join("\n") ?? ""}</textarea>
    <label for={`experiment-git-revision${id}`}>{messages.gitRevision}</label>
    <input id={`experiment-git-revision${id}`} name="gitRevision" value={experiment?.gitRevision ?? ""} autocomplete="off" />
    <button type="submit">{experiment ? messages.updateExperiment : messages.createExperiment}</button>
  </form>;
}

export function ExperimentSummary({ messages, experiment }: { messages: Messages; experiment: ExperimentRecord }) {
  return <article data-experiment-id={experiment.id}>
    <h3>{messages.experimentsTitle} · {experimentStateLabel(messages, experiment.state)}</h3>
    <dl>
      <dt>{messages.hypothesis}</dt><dd><pre>{experiment.hypothesis}</pre></dd>
      <dt>{messages.change}</dt><dd><pre>{experiment.change}</pre></dd>
      <dt>{messages.observation}</dt><dd><pre>{experiment.observation}</pre></dd>
      <dt>{messages.conclusion}</dt><dd><pre>{experiment.conclusion}</pre></dd>
      <dt>{messages.tags}</dt><dd>{experiment.tags.join(", ") || "—"}</dd>
      <dt>{messages.workloads}</dt><dd>{experiment.workloads.map(workloadText).join("; ") || "—"}</dd>
      <dt>{messages.gitRevision}</dt><dd>{experiment.gitRevision ?? "—"}</dd>
    </dl>
    <ConfirmedLinkDetails messages={messages} links={experiment.confirmedLinks} />
  </article>;
}

export function ConfirmedLinkDetails({ messages, links }: { messages: Messages; links: readonly ConfirmedLinkRecord[] | undefined }) {
  if (!links || links.length === 0) return null;
  const relationships = links.map((link) => `${link.leftEntryId} ↔ ${link.rightEntryId}`).join(", ");
  return <p class="notice"><strong>{messages.confirmedLink}</strong>: {relationships} · {messages.confirmedBy}: {links.map((link) => link.confirmedByMemberId).join(", ")}</p>;
}

export function ExperimentsSection({ language, messages, member, experiments, feedback }: {
  language: Language;
  messages: Messages;
  member: AuthenticatedSession["member"];
  experiments: readonly ExperimentRecord[];
  feedback?: ExperimentFeedback | undefined;
}) {
  const writable = hasExperimentWrite(member);
  return <section aria-labelledby="experiments-title">
    <h2 id="experiments-title">{messages.experimentsTitle}</h2>
    <p>{messages.experimentsDescription}</p>
    {feedback?.saved === "created" ? <p class="notice" role="status">{messages.experimentCreated}</p> : null}
    {feedback?.saved === "updated" ? <p class="notice" role="status">{messages.experimentUpdated}</p> : null}
    {feedback?.error ? <p class="error" role="alert">{feedback.error}</p> : null}
    {writable
      ? <><h3>{messages.createExperiment}</h3><ExperimentForm language={language} messages={messages} /></>
      : <p class="hint">{messages.experimentWriteDenied}</p>}
    {experiments.length > 0
      ? experiments.map((experiment) => <ExperimentSummary messages={messages} experiment={experiment} />)
      : <p>{messages.noExperiments}</p>}
    {writable ? experiments.map((experiment) => <details>
      <summary>{messages.updateExperiment}: {experiment.id}</summary>
      <ExperimentForm language={language} messages={messages} experiment={experiment} />
    </details>) : null}
  </section>;
}
