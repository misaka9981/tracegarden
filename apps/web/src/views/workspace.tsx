import { type ClusterScope } from "../../../../packages/cluster/src/index.js";
import { type TimelineEntry, type TimelinePage, type TimelineQuery } from "../../../../packages/db/src/index.js";
import { type CorrelationSuggestionRecord, type ExperimentRecord, type RetentionCleanupResult, type RetentionPolicy } from "../../../../packages/domain/src/index.js";
import { capabilities, hasCapability, type AuthenticatedSession } from "../../../../packages/identity/src/index.js";
import { messagesFor, type Language } from "../../../../packages/i18n/src/index.js";
import { type RecentLogWindow } from "../../../../packages/logs/src/index.js";
import { ClusterSection } from "./cluster.js";
import { CorrelationSection } from "./correlations.js";
import { ExperimentsSection } from "./experiments.js";
import { LanguageLinks, Page, renderView } from "./shared.js";
import { RecentLogsSection } from "./logs.js";
import { RetentionSection } from "./retention.js";
import { TimelineSection } from "./timeline.js";

export type ApplicationFeedback = Readonly<{
  saved?: boolean;
  error?: string;
  logResult?: RecentLogWindow;
  logError?: string;
  attentionReviewed?: boolean;
  experimentSaved?: "created" | "updated";
  experimentError?: string;
  correlationDecision?: "confirmed" | "rejected";
  correlationError?: string;
  retentionSaved?: boolean;
  retentionResult?: RetentionCleanupResult;
  retentionError?: string;
}>;

export function renderApplicationPage(
  language: Language,
  session: AuthenticatedSession,
  scope: ClusterScope | null = null,
  feedback?: ApplicationFeedback,
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
  return renderView(<Page language={language} title={messages.workspaceTitle}>
    <p class="hint">{messages.appName}</p>
    <h1>{messages.workspaceTitle}</h1>
    <p>{messages.welcome}, {member.identity.displayName}.</p>
    <p><strong>{messages.signedInAs}:</strong> {member.identity.email}</p>
    <h2>{messages.capabilities}</h2>
    <ul class="capabilities">{member.capabilities.map((capability) => <li>{capability}</li>)}</ul>
    {hasCapability(member, capabilities.membershipManage) ? <p><a href={`/members?lang=${language}`}>{messages.membershipTitle}</a></p> : null}
    <ClusterSection language={language} messages={messages} member={member} scope={scope} feedback={feedback} />
    <RetentionSection language={language} messages={messages} member={member} policy={retentionPolicy} feedback={{
      saved: feedback?.retentionSaved,
      result: feedback?.retentionResult,
      error: feedback?.retentionError,
    }} />
    {hasCapability(member, capabilities.timelineRead)
      ? <TimelineSection language={language} messages={messages} page={timelinePage} query={timelineQuery ?? { limit: 100 }} reviewed={feedback?.attentionReviewed} />
      : null}
    {hasCapability(member, capabilities.timelineRead)
      ? <ExperimentsSection language={language} messages={messages} member={member} experiments={listedExperiments} feedback={{
        saved: feedback?.experimentSaved,
        error: feedback?.experimentError,
      }} />
      : null}
    {hasCapability(member, capabilities.timelineRead)
      ? <CorrelationSection language={language} messages={messages} member={member} suggestions={correlationSuggestions} entries={timelinePage.entries} feedback={{
        decision: feedback?.correlationDecision,
        error: feedback?.correlationError,
      }} />
      : null}
    <RecentLogsSection language={language} messages={messages} member={member} scope={scope} feedback={{
      logResult: feedback?.logResult,
      logError: feedback?.logError,
    }} />
    <form method="post" action={`/auth/logout?lang=${language}`}><button type="submit">{messages.signOut}</button></form>
    <LanguageLinks language={language} messages={messages} path="/app" />
  </Page>);
}
