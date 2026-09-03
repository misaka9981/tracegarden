import { hasRetentionManagement, type RetentionCleanupResult, type RetentionPolicy } from "../../../../packages/domain/src/index.js";
import { type AuthenticatedSession } from "../../../../packages/identity/src/index.js";
import { type Language, type Messages } from "../../../../packages/i18n/src/index.js";

export type RetentionFeedback = Readonly<{ saved?: boolean | undefined; result?: RetentionCleanupResult | undefined; error?: string | undefined }>;

export function retentionMessage(template: string, result: RetentionCleanupResult): string {
  return template.replace("{eligible}", String(result.eligibleObservations))
    .replace("{protected}", String(result.protectedObservations))
    .replace("{deleted}", String(result.deletedObservations))
    .replace("{entries}", String(result.deletedTimelineEntries))
    .replace("{failures}", String(result.failures));
}

export function RetentionSection({ language, messages, member, policy, feedback }: {
  language: Language;
  messages: Messages;
  member: AuthenticatedSession["member"];
  policy: RetentionPolicy | null;
  feedback?: RetentionFeedback | undefined;
}) {
  const policyDays = policy?.retentionDays ?? 90;
  const result = feedback?.result;
  const resultMessage = result
    ? result.failures > 0
      ? messages.retentionCleanupFailed
      : retentionMessage(messages.retentionCleanupComplete, result)
    : "";
  return <section aria-labelledby="retention-title">
    <h2 id="retention-title">{messages.retentionTitle}</h2>
    <p>{messages.retentionDescription}</p>
    {feedback?.saved ? <p class="notice" role="status">{messages.retentionSaved}</p> : null}
    {feedback?.error ? <p class="error" role="alert">{feedback.error}</p> : null}
    {resultMessage ? <p class={result?.failures ? "error" : "notice"} role="status">{resultMessage}</p> : null}
    <p><strong>{messages.retentionDays}:</strong> {policyDays}</p>
    {hasRetentionManagement(member)
      ? <>
        <form method="post" action={`/retention/update?lang=${language}`}>
          <label for="retention-days">{messages.retentionDays}</label>
          <input id="retention-days" name="retentionDays" type="number" min={1} max={3650} step={1} required value={policyDays} />
          <button type="submit">{messages.saveRetention}</button>
        </form>
        <form method="post" action={`/retention/cleanup?lang=${language}`}>
          <button type="submit">{messages.runRetentionCleanup}</button>
        </form>
      </>
      : <p class="error" role="alert">{messages.retentionManageDenied}</p>}
  </section>;
}
