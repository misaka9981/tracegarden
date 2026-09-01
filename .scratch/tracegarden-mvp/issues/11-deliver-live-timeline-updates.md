# 11: Deliver live Timeline updates with cursor recovery

**What to build:** A Member viewing the Timeline sees newly committed entries within five seconds under normal conditions. The live channel is only a hint: disconnects, missed notifications, and duplicate notifications recover through the durable cursor without losing or duplicating entries.

**Blocked by:** 08: Browse and review durable Timeline history.

**Status:** ready-for-agent

- [ ] A Timeline transaction emits a PostgreSQL notification only after commit and includes only an entry identifier or cursor.
- [ ] The web process translates notifications into authorized SSE hints without embedding Timeline content in the notification channel.
- [ ] The browser responds to a hint by querying all missing rows from the authoritative cursor API.
- [ ] A normally connected browser displays a new committed Timeline Entry within five seconds.
- [ ] SSE reconnect, missed hints, and duplicate hints neither lose nor duplicate Timeline Entries.
- [ ] An uncommitted or rolled-back entry is never announced to clients.
- [ ] Deterministic integration tests coordinate commit, notification, reconnect, and cursor recovery without timing sleeps.
- [ ] SSE client count and cursor-lag signals are exposed for operational telemetry.
