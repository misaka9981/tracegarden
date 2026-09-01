# 02: Bootstrap Workspace admission

**What to build:** The first configured identity can enter Tracegarden as the owner of the shared Workspace, while an identity without admission is rejected. The complete path includes durable identity and session state, Capability-based authorization, login and rejection UI, and automated use of the local identity adapter without requiring Google credentials.

**Blocked by:** 01: Establish the executable foundation.

**Status:** ready-for-agent

- [ ] The first configured external identity becomes the owner and a durable Member of the single Workspace.
- [ ] External identity is keyed by issuer and subject; email is used only for display and Invitation matching.
- [ ] Google OAuth configuration is supported for production without making real Google access a test dependency.
- [ ] Automated tests can select admitted and rejected identities through the local identity adapter.
- [ ] Successful admission creates a database-backed session and reaches an authenticated bilingual application screen.
- [ ] An identity that is neither the bootstrap owner nor admitted by an Invitation receives a clear rejection and no Membership.
- [ ] Protected handlers authorize named Capabilities rather than comparing role names directly.
