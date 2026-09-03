import { hasCorrelationReview, type CorrelationSuggestionRecord } from "../../../../packages/domain/src/index.js";
import { type AuthenticatedSession } from "../../../../packages/identity/src/index.js";
import { type Language, type Messages } from "../../../../packages/i18n/src/index.js";
import { type TimelineEntry } from "../../../../packages/db/src/index.js";

export type CorrelationFeedback = Readonly<{ decision?: "confirmed" | "rejected" | undefined; error?: string | undefined }>;

export function CorrelationSection({ language, messages, member, suggestions, entries, feedback }: {
  language: Language;
  messages: Messages;
  member: AuthenticatedSession["member"];
  suggestions: readonly CorrelationSuggestionRecord[];
  entries: readonly TimelineEntry[];
  feedback?: CorrelationFeedback | undefined;
}) {
  const labelFor = (id: string): string => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) return id;
    return entry.entryType === "experiment"
      ? `${messages.experimentsTitle}: ${entry.experiment.hypothesis}`
      : `${entry.observation.kind} ${entry.observation.namespace}/${entry.observation.name}`;
  };
  return <section aria-labelledby="correlations-title">
    <h2 id="correlations-title">{messages.correlationsTitle}</h2>
    <p>{messages.correlationsDescription}</p>
    {feedback?.decision === "confirmed" ? <p class="notice" role="status">{messages.suggestionConfirmed}</p> : null}
    {feedback?.decision === "rejected" ? <p class="notice" role="status">{messages.suggestionRejected}</p> : null}
    {feedback?.error ? <p class="error" role="alert">{feedback.error}</p> : null}
    {suggestions.length > 0
      ? suggestions.map((suggestion) => <article data-correlation-suggestion-id={suggestion.id}>
        <h3>{messages.correlationsTitle}</h3>
        <p>{labelFor(suggestion.leftEntryId)} ↔ {labelFor(suggestion.rightEntryId)}</p>
        <p><strong>{messages.correlationSignals}:</strong> {suggestion.signals.map((signal) => messages.correlationSignalLabels[signal] ?? signal).join(", ")}</p>
        {hasCorrelationReview(member)
          ? <><form method="post" action={`/correlations/suggestions/${encodeURIComponent(suggestion.id)}/confirm?lang=${language}`}><button type="submit">{messages.confirmSuggestion}</button></form><form method="post" action={`/correlations/suggestions/${encodeURIComponent(suggestion.id)}/reject?lang=${language}`}><button type="submit">{messages.rejectSuggestion}</button></form></>
          : <p class="hint">{messages.correlationReviewDenied}</p>}
      </article>)
      : <p>{messages.noCorrelationSuggestions}</p>}
  </section>;
}
