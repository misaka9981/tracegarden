# 03: Structure server views with Hono JSX

**What to build:** Move server-rendered pages out of the transport module into cohesive Hono JSX view modules without introducing React, hydration, or a client state framework.

**Blocked by:** 02: Adopt Hono transport on Node.

**Status:** resolved

- [x] Status, login/rejection, Workspace Timeline, Experiments, Correlations, Cluster, retention, logs, and membership views have clear module ownership.
- [x] Native forms, progressive navigation, Simplified Chinese default, English switching, escaping, accessibility labels, and capability-sensitive presentation retain parity.
- [x] The Timeline's small `fetch`/`EventSource` behavior remains bounded and framework-free.
- [x] Authorization remains server-side; view visibility is not treated as enforcement.
- [x] Obsolete string renderers and duplicate markup paths are removed.
- [x] Browser/core-loop tests and `pnpm acceptance` pass.

## Safe stop rules

Do not add React, a virtual DOM client bundle, hydration, TanStack Router/Start, Tailwind, or a general component abstraction without two real callers.

## Answer

Implemented Hono JSX server views under `apps/web/src/views/` for authentication/status, workspace composition, Timeline, Experiments, Correlations, Cluster, retention, logs, and membership. Transport now imports the view renderers, Hono escapes JSX text and attributes, and the Timeline client remains a bounded raw `fetch`/`EventSource` script with no hydration or client framework. Added JSX escaping boundary assertions and retained the existing browser/core-loop coverage.

Frozen install, format, lint, typecheck, build, unit, browser, core-loop, PostgreSQL, container, chart, delivery, and full `pnpm acceptance` checks passed on the available Node 24 host (with the expected Node 26 engine warning).
