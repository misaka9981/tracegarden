import { type TimelineEntry, type TimelinePage, type TimelineQuery, type ObservationTimelineEntry } from "../../../../packages/db/src/index.js";
import { type Language, type Messages } from "../../../../packages/i18n/src/index.js";
import { ConfirmedLinkDetails } from "./experiments.js";
import { experimentStateLabel } from "./experiments.js";

const timelineClientScript = `
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
        })();`;

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

export function TimelineSection({ language, messages, page, query, reviewed = false }: {
  language: Language;
  messages: Messages;
  page: TimelinePage;
  query: TimelineQuery;
  reviewed?: boolean | undefined;
}) {
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
  return <section aria-labelledby="timeline-title" data-live-timeline="true" data-timeline-limit={query.limit} data-timeline-kind={query.kind} data-timeline-namespace={query.namespace} data-timeline-name={query.name} data-timeline-state={query.state} data-timeline-attention={query.attention} data-timeline-unread={query.unread} data-timeline-cursor={page.resumeCursor}>
    <h2 id="timeline-title">{messages.timelineTitle}</h2>
    <p>{messages.timelineDescription}</p>
    {reviewed ? <p class="notice" role="status">{messages.attentionReviewed}</p> : null}
    {page.unreadAttentionCount === undefined ? null : <p class="notice" data-unread-attention-count="true">{messages.unreadAttentionCount}: {page.unreadAttentionCount}</p>}
    <form method="get" action="/app">
      <input type="hidden" name="lang" value={language} />
      <label for="timeline-namespace">{messages.timelineNamespace}</label>
      <input id="timeline-namespace" name="namespace" value={query.namespace ?? ""} maxlength={63} />
      <label for="timeline-name">{messages.timelineName}</label>
      <input id="timeline-name" name="name" value={query.name ?? ""} maxlength={253} />
      <label for="timeline-state">{messages.timelineState}</label>
      <select id="timeline-state" name="state">
        <option value="">{messages.timelineAllStates}</option>
        {["Pending", "Running", "Succeeded", "Failed", "Unknown"].map((state) => <option value={state} selected={query.state === state}>{timelineStateLabel(messages, state)}</option>)}
      </select>
      <label for="timeline-attention">{attentionLabel}</label>
      <select id="timeline-attention" name="attention">
        <option value="">{messages.timelineAllAttention}</option>
        <option value="true" selected={attentionFilter === "attention"}>{attentionOnlyLabel}</option>
        <option value="unread" selected={attentionFilter === "unread"}>{unreadAttentionOnlyLabel}</option>
      </select>
      <button type="submit">{messages.filterTimeline}</button>
    </form>
    {page.entries.length > 0
      ? page.entries.map((entry) => entry.entryType === "experiment"
        ? <article data-entry-id={entry.id} data-entry-occurred-at={entry.occurredAt}>
          <h3>{messages.experimentsTitle} · {experimentStateLabel(messages, entry.experiment.state)}</h3>
          <p>{entry.experiment.hypothesis}</p><p>{entry.occurredAt}</p>
          <ConfirmedLinkDetails messages={messages} links={entry.confirmedLinks} />
        </article>
        : <ObservationEntry messages={messages} language={language} entry={entry} />)
      : <p>{messages.noTimelineEntries}</p>}
    {page.nextCursor ? <p><a href={timelineNextPageUrl(language, query, page.nextCursor)}>{messages.nextTimelinePage}</a></p> : null}
    <script dangerouslySetInnerHTML={{ __html: timelineClientScript }} />
  </section>;
}

function ObservationEntry({ messages, language, entry }: { messages: Messages; language: Language; entry: ObservationTimelineEntry }) {
  const observation = entry.observation;
  const owners = (observation.ownerReferences ?? []).map((owner) => `${owner.kind}/${owner.name}`).join(", ");
  return <article data-entry-id={entry.id} data-entry-occurred-at={entry.occurredAt}>
    <h3>{resourceKindLabel(observation.kind, messages)} · {observationStateLabel(entry, messages)}</h3>
    <p>{observation.namespace}/{observation.name} · {observationDetail(entry, messages)}</p>
    {entry.attentionItem
      ? <><p><strong>{messages.attentionItem}</strong> {attentionReasonLabel(entry, messages)} · {entry.attentionUnread ? messages.attentionUnread : messages.attentionReviewed}</p>
        {entry.attentionUnread ? <form method="post" action={`/timeline/entries/${encodeURIComponent(entry.id)}/review?lang=${language}`}><button type="submit">{messages.reviewAttention}</button></form> : null}</>
      : null}
    {entry.recoveryOf || observation.classification === "recovery" ? <p class="notice">{messages.recovery}</p> : null}
    <ConfirmedLinkDetails messages={messages} links={entry.confirmedLinks} />
    <dl>
      <dt>{messages.clusterName}</dt><dd>{entry.clusterId}</dd>
      <dt>{messages.resourceIdentity}</dt><dd>{observation.sourceIdentity}</dd>
      <dt>{messages.ownership}</dt><dd>{owners || messages.timelineUnknownState}</dd>
      <dt>{messages.revision}</dt><dd>{observation.revision ?? messages.timelineUnknownState}</dd>
      <dt>{messages.observedAt}</dt><dd>{entry.occurredAt}</dd>
    </dl>
  </article>;
}
