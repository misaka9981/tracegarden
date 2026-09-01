# 02: Bootstrap Workspace admission

**What to build:** The first configured identity can enter Tracegarden as the owner of the shared Workspace, while an identity without admission is rejected. The complete path includes durable identity and session state, Capability-based authorization, login and rejection UI, and automated use of the local identity adapter without requiring Google credentials.

**Blocked by:** 01: Establish the executable foundation.

**Status:** resolved

- [x] The first configured external identity becomes the owner and a durable Member of the single Workspace.
- [x] External identity is keyed by issuer and subject; email is used only for display and Invitation matching.
- [x] Google OAuth configuration is supported for production without making real Google access a test dependency.
- [x] Automated tests can select admitted and rejected identities through the local identity adapter.
- [x] Successful admission creates a database-backed session and reaches an authenticated bilingual application screen.
- [x] An identity that is neither the bootstrap owner nor admitted by an Invitation receives a clear rejection and no Membership.
- [x] Protected handlers authorize named Capabilities rather than comparing role names directly.

## Answer

Implemented Better Auth 1.3.24 Google identity/session integration with explicit production bootstrap issuer and subject, durable PostgreSQL Membership and session admission, Invitation matching, named Capability authorization, local identity tests, bilingual login/application/rejection screens, and fail-closed production admission-store selection. Production rejects memory databases, injected stores/adapters, non-Postgres databases, missing database-owned admission, insecure Better Auth URLs, and missing bootstrap configuration.

Verified locally with frozen offline installation, formatting, lint, TypeScript, build, unit, browser, PostgreSQL, and non-root Node 26.8 ARM64 container checks. PostgreSQL smoke covered migrations, owner admission, durable session access, rejection, and production Better Auth redirect configuration; callback cookie forwarding and account-session mapping use deterministic local test doubles. Real Google OAuth callbacks and external Google behavior remain unverified by policy. No external account, VM, Kubernetes context, cloud system, or live service was contacted.
