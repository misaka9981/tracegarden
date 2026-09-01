# 08: Browse and review durable Timeline history

**What to build:** A Member can navigate persisted Timeline history predictably, narrow it to relevant work, and distinguish unread Attention Items from entries already reviewed. Pagination remains stable while new Observations arrive.

**Blocked by:** 05: Carry one Pod Observation into the Timeline.

**Status:** resolved

- [x] Timeline queries use an opaque stable cursor and deterministic chronological ordering.
- [x] Moving between pages does not duplicate or skip persisted entries when newer entries are inserted.
- [x] Members can filter by supported entry characteristics needed for workload investigation.
- [x] Attention Items expose an unread state scoped to the reviewing Member.
- [x] A Member can mark an Attention Item reviewed and the durable unread count updates idempotently.
- [x] All list, filter, cursor, and attention inputs are runtime-validated and authorized.
- [x] Repository integration tests exercise cursor boundaries and unread state against disposable PostgreSQL.
- [x] Playwright covers browsing, filtering, and Attention Item review in Simplified Chinese and English.

## Answer

Implemented durable Timeline browsing, stable member-bound HMAC cursors, filter and review flows, PostgreSQL Attention Item persistence, and bilingual browser coverage. Production now requires the database-owned Timeline store and cursor secret. All required unit, PostgreSQL, browser, container, format, lint, typecheck, and build checks pass.
