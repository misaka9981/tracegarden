# 11: Deliver live Timeline updates with cursor recovery

**What to build:** A Member viewing the Timeline sees newly committed entries within five seconds under normal conditions. The live channel is only a hint: disconnects, missed notifications, and duplicate notifications recover through the durable cursor without losing or duplicating entries.

**Blocked by:** 08: Browse and review durable Timeline history.

**Status:** resolved

- [x] A Timeline transaction emits a PostgreSQL notification only after commit and includes only an entry identifier or cursor.
- [x] The web process translates notifications into authorized SSE hints without embedding Timeline content in the notification channel.
- [x] The browser responds to a hint by querying all missing rows from the authoritative cursor API.
- [x] A normally connected browser displays a new committed Timeline Entry within five seconds.
- [x] SSE reconnect, missed hints, and duplicate hints neither lose nor duplicate Timeline Entries.
- [x] An uncommitted or rolled-back entry is never announced to clients.
- [x] Deterministic integration tests coordinate commit, notification, reconnect, and cursor recovery without timing sleeps.
- [x] SSE client count and cursor-lag signals are exposed for operational telemetry.

## Answer

Implemented durable monotonic Timeline cursors, commit-ordered PostgreSQL Timeline writes, authorized/coalesced SSE hints with bounded backpressure and listener-failure recovery, and complete Workspace/Cluster ownership validation across Observation and ingestion-checkpoint mutation seams. Migration 0013 preflights legacy mismatches without reassignment or payload loss and reports actionable remediation details. Added deterministic unit, browser, PostgreSQL, concurrency, rollback, recovery, parity, and migration-ownership coverage; all affected checks pass.
