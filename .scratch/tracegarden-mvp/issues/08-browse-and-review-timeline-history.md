# 08: Browse and review durable Timeline history

**What to build:** A Member can navigate persisted Timeline history predictably, narrow it to relevant work, and distinguish unread Attention Items from entries already reviewed. Pagination remains stable while new Observations arrive.

**Blocked by:** 05: Carry one Pod Observation into the Timeline.

**Status:** ready-for-agent

- [ ] Timeline queries use an opaque stable cursor and deterministic chronological ordering.
- [ ] Moving between pages does not duplicate or skip persisted entries when newer entries are inserted.
- [ ] Members can filter by supported entry characteristics needed for workload investigation.
- [ ] Attention Items expose an unread state scoped to the reviewing Member.
- [ ] A Member can mark an Attention Item reviewed and the durable unread count updates idempotently.
- [ ] All list, filter, cursor, and attention inputs are runtime-validated and authorized.
- [ ] Repository integration tests exercise cursor boundaries and unread state against disposable PostgreSQL.
- [ ] Playwright covers browsing, filtering, and Attention Item review in Simplified Chinese and English.
