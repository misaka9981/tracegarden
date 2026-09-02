# 03: Structure server views with Hono JSX

**What to build:** Move server-rendered pages out of the transport module into cohesive Hono JSX view modules without introducing React, hydration, or a client state framework.

**Blocked by:** 02: Adopt Hono transport on Node.

**Status:** ready-for-agent

- [ ] Status, login/rejection, Workspace Timeline, Experiments, Correlations, Cluster, retention, logs, and membership views have clear module ownership.
- [ ] Native forms, progressive navigation, Simplified Chinese default, English switching, escaping, accessibility labels, and capability-sensitive presentation retain parity.
- [ ] The Timeline's small `fetch`/`EventSource` behavior remains bounded and framework-free.
- [ ] Authorization remains server-side; view visibility is not treated as enforcement.
- [ ] Obsolete string renderers and duplicate markup paths are removed.
- [ ] Browser/core-loop tests and `pnpm acceptance` pass.

## Safe stop rules

Do not add React, a virtual DOM client bundle, hydration, TanStack Router/Start, Tailwind, or a general component abstraction without two real callers.
