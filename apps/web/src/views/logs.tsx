import { hasLogReadCapability, type RecentLogWindow } from "../../../../packages/logs/src/index.js";
import { type AuthenticatedSession } from "../../../../packages/identity/src/index.js";
import { type Language, type Messages } from "../../../../packages/i18n/src/index.js";
import { type ClusterScope } from "../../../../packages/cluster/src/index.js";

export type LogFeedback = Readonly<{ logResult?: RecentLogWindow | undefined; logError?: string | undefined }>;

export function RecentLogsSection({ language, messages, member, scope, feedback }: {
  language: Language;
  messages: Messages;
  member: AuthenticatedSession["member"];
  scope: ClusterScope | null;
  feedback?: LogFeedback | undefined;
}) {
  return <section aria-labelledby="recent-logs-title">
    <h2 id="recent-logs-title">{messages.recentLogsTitle}</h2>
    <p>{messages.recentLogsDescription}</p>
    {feedback?.logError ? <p class="error" role="alert">{feedback.logError}</p> : null}
    {hasLogReadCapability(member)
      ? <form method="post" action={`/logs/recent?lang=${language}`}>
        <label for="log-cluster">{messages.logCluster}</label>
        <input id="log-cluster" name="clusterId" required value={scope?.clusterId ?? ""} autocomplete="off" />
        <label for="log-namespace">{messages.logNamespace}</label>
        <input id="log-namespace" name="namespace" required value={scope?.namespaces[0] ?? ""} autocomplete="off" />
        <label for="log-pod">{messages.logPod}</label>
        <input id="log-pod" name="pod" required autocomplete="off" />
        <label for="log-container">{messages.logContainer}</label>
        <input id="log-container" name="container" required autocomplete="off" />
        <label for="log-tail">{messages.logTail}</label>
        <input id="log-tail" name="tail" type="number" min={1} max={200} value={50} required />
        <button type="submit">{messages.requestLogs}</button>
      </form>
      : <p class="error" role="alert">{messages.logsReadDenied}</p>}
    {feedback?.logResult
      ? <>
        <p class="hint">{messages.recentLogsMetadata} {feedback.logResult.lineCount} lines · {feedback.logResult.byteCount} bytes</p>
        <pre aria-label={messages.recentLogsTitle}>{feedback.logResult.body || messages.recentLogsEmpty}</pre>
      </>
      : null}
  </section>;
}
