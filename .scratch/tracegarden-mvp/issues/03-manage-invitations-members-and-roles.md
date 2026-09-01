# 03: Manage Invitations, Members, and roles

**What to build:** An owner can admit and administer Members in the shared Workspace through revocable Invitations and role assignments, with capability enforcement and an immutable audit trail. The workflow is usable from the bilingual UI and proves that Google authentication alone never grants access.

**Blocked by:** 02: Bootstrap Workspace admission.

**Status:** ready-for-agent

- [ ] An owner can create an Invitation for one normalized email address and can revoke it before use.
- [ ] A matching Google identity can consume a valid Invitation after authentication and becomes a Member exactly once.
- [ ] Missing, revoked, mismatched, or already-consumed Invitations do not grant Membership.
- [ ] An owner can list Members and assign the owner, operator, and viewer roles.
- [ ] Role changes alter the Member's effective Capabilities on the next authorized request without scattering role-name checks through handlers.
- [ ] A Member without membership-management Capabilities cannot create Invitations or change roles through either UI or API.
- [ ] Invitation, admission, revocation, and role-change actions create immutable audit records without sensitive token material.
- [ ] The complete workflow and its denial cases are covered through the local identity adapter in both supported UI languages.
