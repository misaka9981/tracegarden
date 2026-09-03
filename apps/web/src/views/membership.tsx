import { type AuthenticatedSession, type InvitationRecord, type MemberRecord } from "../../../../packages/identity/src/index.js";
import { messagesFor, type Language, type Messages } from "../../../../packages/i18n/src/index.js";
import { LanguageLinks, Page, renderView } from "./shared.js";

function invitationStatus(invitation: InvitationRecord, messages: Messages): string {
  return invitation.revokedAt ? messages.revoked : invitation.acceptedAt ? messages.accepted : messages.pending;
}

export function renderMembersPage(language: Language, session: AuthenticatedSession, members: readonly MemberRecord[], invitations: readonly InvitationRecord[], notice?: string): string {
  const messages = messagesFor(language);
  return renderView(<Page language={language} title={messages.membershipTitle}>
    <p class="hint">{messages.appName}</p>
    <h1>{messages.membershipTitle}</h1>
    <p><strong>{messages.signedInAs}:</strong> {session.member.identity.email}</p>
    {notice ? <p class="notice" role="status">{notice}</p> : null}
    <h2>{messages.members}</h2>
    <table><thead><tr><th>{messages.members}</th><th>{messages.role}</th></tr></thead><tbody>
      {members.length > 0
        ? members.map((member) => <tr>
          <td>{member.identity.displayName}<br /><span class="hint">{member.identity.email}</span></td>
          <td><form method="post" action="/members/role">
            <input type="hidden" name="lang" value={language} />
            <input type="hidden" name="memberId" value={member.id} />
            <label><span class="hint">{messages.role}</span>
              <select name="role" aria-label={`${messages.role}: ${member.identity.email}`}>
                {["owner", "operator", "viewer"].map((role) => <option value={role} selected={member.role === role}>{role}</option>)}
              </select>
            </label>
            <button type="submit">{messages.saveRole}</button>
          </form></td>
        </tr>)
        : <tr><td colspan={2}>—</td></tr>}
    </tbody></table>
    <h2>{messages.invitations}</h2>
    <form method="post" action="/members/invite">
      <input type="hidden" name="lang" value={language} />
      <label for="invite-email">{messages.inviteEmail}</label>
      <input id="invite-email" name="email" type="email" required autocomplete="email" />
      <button type="submit">{messages.createInvitation}</button>
    </form>
    <table><thead><tr><th>{messages.inviteEmail}</th><th>{messages.role}</th><th /></tr></thead><tbody>
      {invitations.length > 0
        ? invitations.map((invitation) => <tr>
          <td>{invitation.email}</td>
          <td>{invitationStatus(invitation, messages)}</td>
          <td>{invitation.revokedAt || invitation.acceptedAt
            ? null
            : <form method="post" action="/members/revoke">
              <input type="hidden" name="lang" value={language} />
              <input type="hidden" name="invitationId" value={invitation.id} />
              <button type="submit">{messages.revokeInvitation}</button>
            </form>}</td>
        </tr>)
        : <tr><td colspan={3}>—</td></tr>}
    </tbody></table>
    <p><a href={`/app?lang=${language}`}>{messages.workspaceTitle}</a></p>
    <form method="post" action={`/auth/logout?lang=${language}`}><button type="submit">{messages.signOut}</button></form>
    <LanguageLinks language={language} messages={messages} path="/members" />
  </Page>);
}
