# 03: Manage Invitations, Members, and roles

**What to build:** An owner can admit and administer Members in the shared Workspace through revocable Invitations and role assignments, with capability enforcement and an immutable audit trail. The workflow is usable from the bilingual UI and proves that Google authentication alone never grants access.

**Blocked by:** 02: Bootstrap Workspace admission.

**Status:** resolved

- [x] An owner can create an Invitation for one normalized email address and can revoke it before use.
- [x] A matching Google identity can consume a valid Invitation after authentication and becomes a Member exactly once.
- [x] Missing, revoked, mismatched, or already-consumed Invitations do not grant Membership.
- [x] An owner can list Members and assign the owner, operator, and viewer roles.
- [x] Role changes alter the Member's effective Capabilities on the next authorized request without scattering role-name checks through handlers.
- [x] A Member without membership-management Capabilities cannot create Invitations or change roles through either UI or API.
- [x] Invitation, admission, revocation, and role-change actions create immutable audit records without sensitive token material.
- [x] The complete workflow and its denial cases are covered through the local identity adapter in both supported UI languages.

## Answer

Implemented invitation admission, role/capability enforcement, bilingual Members UI/API, and immutable audit records for memory and PostgreSQL stores.

Local verification passed: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `node scripts/browser-smoke.mjs`, and `node scripts/postgres-smoke.mjs`.

External Google OAuth behavior remains unverified; the PostgreSQL smoke only validates local Better Auth wiring and redirect construction.
