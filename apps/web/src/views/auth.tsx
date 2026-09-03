import { type IdentityAdapter } from "../../../../packages/identity/src/index.js";
import { messagesFor, type Language } from "../../../../packages/i18n/src/index.js";
import { Check, LanguageLinks, Page, renderView } from "./shared.js";

export function renderStatusPage(language: Language, databaseReady: boolean): string {
  const messages = messagesFor(language);
  return renderView(<Page language={language} title={messages.statusTitle}>
    <p class="hint">{messages.appName}</p>
    <h1>{messages.statusTitle}</h1>
    <p>{messages.statusDescription}</p>
    <ul>
      <Check label={messages.webProcess} ready={true} messages={messages} />
      <Check label={messages.database} ready={databaseReady} messages={messages} />
    </ul>
    <p class="hint">{messages.noConfiguration}</p>
    <LanguageLinks language={language} messages={messages} />
  </Page>);
}

export function renderLoginPage(language: Language, databaseReady: boolean, adapter: IdentityAdapter, error?: string, selected?: string): string {
  const messages = messagesFor(language);
  return renderView(<Page language={language} title={messages.statusTitle}>
    <p class="hint">{messages.appName}</p>
    <h1>{messages.statusTitle}</h1>
    <p>{messages.statusDescription}</p>
    <ul>
      <Check label={messages.webProcess} ready={true} messages={messages} />
      <Check label={messages.database} ready={databaseReady} messages={messages} />
    </ul>
    <h2>{messages.loginTitle}</h2>
    <p>{messages.loginDescription}</p>
    {error ? <p class="error" role="alert">{error}</p> : null}
    {adapter.kind === "local"
      ? <form method="post" action="/auth/login">
        <input type="hidden" name="lang" value={language} />
        <label for="identity">{messages.localIdentity}</label>
        <select id="identity" name="identity">
          {adapter.options.map((option) => <option value={option.key} selected={option.key === selected}>{option.displayName} · {option.email}</option>)}
        </select>
        <button type="submit">{messages.signIn}</button>
      </form>
      : <p><a href={`/auth/google?lang=${language}`}>{messages.googleSignIn}</a></p>}
    <p class="hint">{messages.noConfiguration}</p>
    <LanguageLinks language={language} messages={messages} />
  </Page>);
}

export function renderMembershipDeniedPage(language: Language): string {
  const messages = messagesFor(language);
  return renderView(<Page language={language} title={messages.membershipTitle}>
    <h1>{messages.membershipTitle}</h1>
    <p role="alert">{messages.membershipDenied}</p>
    <p><a href={`/app?lang=${language}`}>{messages.workspaceTitle}</a></p>
    <form method="post" action={`/auth/logout?lang=${language}`}><button type="submit">{messages.signOut}</button></form>
    <LanguageLinks language={language} messages={messages} path="/members" />
  </Page>);
}

export function renderRejectionPage(language: Language, reason: "admission_required" | "invalid_identity"): string {
  const messages = messagesFor(language);
  const description = reason === "admission_required" ? messages.rejectionDescription : messages.admissionRequired;
  return renderView(<Page language={language} title={messages.rejectionTitle}>
    <p class="hint">{messages.appName}</p>
    <h1>{messages.rejectionTitle}</h1>
    <p role="alert">{description}</p>
    <p><a href={`/?lang=${language}`}>{messages.signIn}</a></p>
    <form method="post" action={`/auth/logout?lang=${language}`}>
      <button type="submit">{messages.signOut}</button>
    </form>
    <LanguageLinks language={language} messages={messages} />
  </Page>);
}
