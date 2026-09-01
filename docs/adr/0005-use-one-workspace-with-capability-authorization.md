# Use one shared workspace with capability authorization

The first release exposes one shared Workspace and admits Google identities through owner-managed Invitations, while records retain `workspaceId` for later expansion. Better Auth establishes identity and session, but Tracegarden owns membership and capability authorization; this keeps future operational permissions independent of OAuth and avoids scattering role-name checks through handlers.
