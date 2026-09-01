import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { state, type StatusResponse } from "../../../packages/contracts/src/index.js";
import { createDatabase, MemoryAdmissionStore, type DatabaseBoundary } from "../../../packages/db/src/index.js";
import {
  configureClusterScope,
  hasClusterConfigureCapability,
  MemoryClusterScopeStore,
  ClusterScopeValidationError,
  SUPPORTED_RESOURCE_KINDS,
  type ClusterScope,
  type ClusterScopeStore,
} from "../../../packages/cluster/src/index.js";
import {
  capabilities,
  configuredBootstrapIdentity,
  createIdentityAdapter,
  GOOGLE_ISSUER,
  hasCapability,
  isRole,
  requireCapability,
  type AdmissionStore,
  type AuthenticatedSession,
  type InvitationRecord,
  type MemberRecord,
  type MembershipStore,
  type Role,
  type BetterAuthRuntime,
  type ExternalIdentity,
  type IdentityAdapter,
} from "../../../packages/identity/src/index.js";
import { messagesFor, parseLanguage, type Language, type Messages } from "../../../packages/i18n/src/index.js";

type WebOptions = Readonly<{
  database?: DatabaseBoundary;
  admissionStore?: AdmissionStore;
  clusterScopeStore?: ClusterScopeStore;
  identityAdapter?: IdentityAdapter;
  environment?: Record<string, string | undefined>;
  port?: number;
  host?: string;
}>;

export type WebRuntime = Readonly<{
  server: Server;
  status: () => Promise<StatusResponse>;
  close: () => Promise<void>;
}>;

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function renderCheck(label: string, ready: boolean, messages: Messages): string {
  const value = ready ? messages.ready : messages.notReady;
  const className = ready ? "ready" : "not-ready";
  return `<li><span>${escapeHtml(label)}</span><strong class="${className}">${escapeHtml(value)}</strong></li>`;
}

function renderLanguageLinks(language: Language, messages: Messages, path = "/"): string {
  const separator = path.includes("?") ? "&" : "?";
  return `<nav aria-label="${escapeHtml(messages.language)}">
        <a href="${path}${separator}lang=zh-CN" lang="zh-CN">${escapeHtml(messages.chinese)}</a>
        <a href="${path}${separator}lang=en" lang="en">${escapeHtml(messages.english)}</a>
      </nav>`;
}

function pageStyles(): string {
  return `<style>
      :root { color-scheme: light; font-family: system-ui, sans-serif; background: #f6f7f9; color: #1f2937; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
      main { width: min(42rem, calc(100% - 2rem)); background: white; border: 1px solid #d9dee8; border-radius: 1rem; padding: 2rem; box-shadow: 0 0.5rem 2rem #1f29371a; }
      h1 { margin-top: 0; }
      p { line-height: 1.6; }
      ul { display: grid; gap: 0.75rem; list-style: none; margin: 1.5rem 0; padding: 0; }
      li { display: flex; justify-content: space-between; border-bottom: 1px solid #edf0f5; padding: 0.75rem 0; }
      .ready { color: #087f5b; }
      .not-ready { color: #b42318; }
      nav { display: flex; gap: 1rem; margin-top: 1rem; }
      nav a { color: #175cd3; }
      .hint { color: #667085; font-size: 0.9rem; }
      form { display: grid; gap: 0.75rem; margin-top: 1.5rem; }
      label { font-weight: 600; }
      select, button { font: inherit; padding: 0.6rem 0.75rem; border: 1px solid #98a2b3; border-radius: 0.4rem; }
      button { background: #175cd3; border-color: #175cd3; color: white; cursor: pointer; }
      .error { color: #b42318; font-weight: 600; }
      .notice { color: #087f5b; font-weight: 600; }
      table { width: 100%; border-collapse: collapse; margin: 1rem 0 1.5rem; }
      th, td { text-align: left; border-bottom: 1px solid #edf0f5; padding: 0.75rem 0.5rem; vertical-align: top; }
      input { font: inherit; padding: 0.6rem 0.75rem; border: 1px solid #98a2b3; border-radius: 0.4rem; }
      .capabilities { display: flex; flex-wrap: wrap; gap: 0.5rem; padding: 0; list-style: none; }
      .capabilities li { border: 1px solid #d9dee8; border-radius: 999px; padding: 0.4rem 0.7rem; }
    </style>`;
}

export function renderStatusPage(language: Language, databaseReady: boolean): string {
  const messages = messagesFor(language);
  return `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(messages.appName)} · ${escapeHtml(messages.statusTitle)}</title>
    ${pageStyles()}
  </head>
  <body>
    <main>
      <p class="hint">${escapeHtml(messages.appName)}</p>
      <h1>${escapeHtml(messages.statusTitle)}</h1>
      <p>${escapeHtml(messages.statusDescription)}</p>
      <ul>
        ${renderCheck(messages.webProcess, true, messages)}
        ${renderCheck(messages.database, databaseReady, messages)}
      </ul>
      <p class="hint">${escapeHtml(messages.noConfiguration)}</p>
      ${renderLanguageLinks(language, messages)}
    </main>
  </body>
</html>`;
}

function renderLocalOptions(adapter: IdentityAdapter, selected: string | undefined): string {
  return adapter.options.map((option) => `<option value="${escapeHtml(option.key)}"${option.key === selected ? " selected" : ""}>${escapeHtml(option.displayName)} · ${escapeHtml(option.email)}</option>`).join("");
}

export function renderLoginPage(language: Language, databaseReady: boolean, adapter: IdentityAdapter, error?: string, selected?: string): string {
  const messages = messagesFor(language);
  const authentication = adapter.kind === "local"
    ? `<form method="post" action="/auth/login">
          <input type="hidden" name="lang" value="${language}">
          <label for="identity">${escapeHtml(messages.localIdentity)}</label>
          <select id="identity" name="identity">${renderLocalOptions(adapter, selected)}</select>
          <button type="submit">${escapeHtml(messages.signIn)}</button>
        </form>`
    : `<p><a href="/auth/google?lang=${language}">${escapeHtml(messages.googleSignIn)}</a></p>`;
  return `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(messages.appName)} · ${escapeHtml(messages.statusTitle)}</title>
    ${pageStyles()}
  </head>
  <body>
    <main>
      <p class="hint">${escapeHtml(messages.appName)}</p>
      <h1>${escapeHtml(messages.statusTitle)}</h1>
      <p>${escapeHtml(messages.statusDescription)}</p>
      <ul>
        ${renderCheck(messages.webProcess, true, messages)}
        ${renderCheck(messages.database, databaseReady, messages)}
      </ul>
      <h2>${escapeHtml(messages.loginTitle)}</h2>
      <p>${escapeHtml(messages.loginDescription)}</p>
      ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
      ${authentication}
      <p class="hint">${escapeHtml(messages.noConfiguration)}</p>
      ${renderLanguageLinks(language, messages)}
    </main>
  </body>
</html>`;
}

function renderClusterSection(
  language: Language,
  messages: Messages,
  member: AuthenticatedSession["member"],
  scope: ClusterScope | null,
  feedback?: Readonly<{ saved?: boolean; error?: string }>,
): string {
  const namespaces = scope?.namespaces.join("\n") ?? "";
  const selectedKinds = new Set(scope?.resourceKinds ?? []);
  const resourceKinds = SUPPORTED_RESOURCE_KINDS.map((kind) => `<label><input type="checkbox" name="resourceKinds" value="${escapeHtml(kind)}"${selectedKinds.has(kind) ? " checked" : ""}> ${escapeHtml(kind)}</label>`).join(" ");
  const summary = scope
    ? `<dl>
        <dt>${escapeHtml(messages.clusterName)}</dt><dd>${escapeHtml(scope.name)}</dd>
        <dt>${escapeHtml(messages.clusterEndpoint)}</dt><dd>${escapeHtml(scope.endpoint)}</dd>
        <dt>${escapeHtml(messages.approvedNamespaces)}</dt><dd>${escapeHtml(scope.namespaces.join(", ") || messages.clusterNotConfigured)}</dd>
        <dt>${escapeHtml(messages.approvedResourceKinds)}</dt><dd>${escapeHtml(scope.resourceKinds.join(", ") || messages.clusterNotConfigured)}</dd>
      </dl>`
    : `<p>${escapeHtml(messages.clusterNotConfigured)}</p>`;
  const form = hasClusterConfigureCapability(member)
    ? `<form method="post" action="/cluster/configure?lang=${language}">
        <input type="hidden" name="clusterId" value="${escapeHtml(scope?.clusterId ?? "")}">
        <label for="cluster-name">${escapeHtml(messages.clusterName)}</label>
        <input id="cluster-name" name="name" required maxlength="100" value="${escapeHtml(scope?.name ?? "")}">
        <label for="cluster-endpoint">${escapeHtml(messages.clusterEndpoint)}</label>
        <input id="cluster-endpoint" name="endpoint" type="url" required value="${escapeHtml(scope?.endpoint ?? "")}">
        <label for="cluster-namespaces">${escapeHtml(messages.approvedNamespaces)}</label>
        <textarea id="cluster-namespaces" name="namespaces" rows="4">${escapeHtml(namespaces)}</textarea>
        <fieldset>
          <legend>${escapeHtml(messages.approvedResourceKinds)}</legend>
          <p class="hint">${escapeHtml(messages.supportedResourceKinds)}</p>
          ${resourceKinds}
        </fieldset>
        <button type="submit">${escapeHtml(messages.saveCluster)}</button>
      </form>`
    : `<p class="error" role="alert">${escapeHtml(messages.clusterConfigurationDenied)}</p>`;
  return `<section aria-labelledby="cluster-scope-title">
      <h2 id="cluster-scope-title">${escapeHtml(messages.clusterTitle)}</h2>
      <p>${escapeHtml(messages.clusterDescription)}</p>
      ${feedback?.saved ? `<p role="status">${escapeHtml(messages.clusterSaved)}</p>` : ""}
      ${feedback?.error ? `<p class="error" role="alert">${escapeHtml(feedback.error)}</p>` : ""}
      ${summary}
      ${form}
    </section>`;
}

export function renderApplicationPage(
  language: Language,
  session: AuthenticatedSession,
  scope: ClusterScope | null = null,
  feedback?: Readonly<{ saved?: boolean; error?: string }>,
): string {
  const messages = messagesFor(language);
  const member = session.member;
  const capabilityList = member.capabilities.map((capability) => `<li>${escapeHtml(capability)}</li>`).join("");
  const membershipLink = hasCapability(member, capabilities.membershipManage)
    ? `<p><a href="/members?lang=${language}">${escapeHtml(messages.membershipTitle)}</a></p>`
    : "";
  return `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(messages.appName)} · ${escapeHtml(messages.workspaceTitle)}</title>
    ${pageStyles()}
  </head>
  <body>
    <main>
      <p class="hint">${escapeHtml(messages.appName)}</p>
      <h1>${escapeHtml(messages.workspaceTitle)}</h1>
      <p>${escapeHtml(messages.welcome)}, ${escapeHtml(member.identity.displayName)}.</p>
      <p><strong>${escapeHtml(messages.signedInAs)}:</strong> ${escapeHtml(member.identity.email)}</p>
      <h2>${escapeHtml(messages.capabilities)}</h2>
      <ul class="capabilities">${capabilityList}</ul>
      ${membershipLink}
      ${renderClusterSection(language, messages, member, scope, feedback)}
      <form method="post" action="/auth/logout?lang=${language}">
        <button type="submit">${escapeHtml(messages.signOut)}</button>
      </form>
      ${renderLanguageLinks(language, messages, "/app")}
    </main>
  </body>
</html>`;
}

function invitationStatus(invitation: InvitationRecord, messages: Messages): string {
  return invitation.revokedAt ? messages.revoked : invitation.acceptedAt ? messages.accepted : messages.pending;
}

export function renderMembersPage(
  language: Language,
  session: AuthenticatedSession,
  members: readonly MemberRecord[],
  invitations: readonly InvitationRecord[],
  notice?: string,
): string {
  const messages = messagesFor(language);
  const memberRows = members.map((member) => `<tr>
      <td>${escapeHtml(member.identity.displayName)}<br><span class="hint">${escapeHtml(member.identity.email)}</span></td>
      <td><form method="post" action="/members/role">
        <input type="hidden" name="lang" value="${language}">
        <input type="hidden" name="memberId" value="${escapeHtml(member.id)}">
        <label><span class="hint">${escapeHtml(messages.role)}</span>
          <select name="role" aria-label="${escapeHtml(messages.role)}: ${escapeHtml(member.identity.email)}">
            ${["owner", "operator", "viewer"].map((role) => `<option value="${role}"${member.role === role ? " selected" : ""}>${role}</option>`).join("")}
          </select>
        </label>
        <button type="submit">${escapeHtml(messages.saveRole)}</button>
      </form></td>
    </tr>`).join("");
  const invitationRows = invitations.map((invitation) => `<tr>
      <td>${escapeHtml(invitation.email)}</td>
      <td>${escapeHtml(invitationStatus(invitation, messages))}</td>
      <td>${invitation.revokedAt || invitation.acceptedAt ? "" : `<form method="post" action="/members/revoke"><input type="hidden" name="lang" value="${language}"><input type="hidden" name="invitationId" value="${escapeHtml(invitation.id)}"><button type="submit">${escapeHtml(messages.revokeInvitation)}</button></form>`}</td>
    </tr>`).join("");
  return `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(messages.appName)} · ${escapeHtml(messages.membershipTitle)}</title>
    ${pageStyles()}
  </head>
  <body>
    <main>
      <p class="hint">${escapeHtml(messages.appName)}</p>
      <h1>${escapeHtml(messages.membershipTitle)}</h1>
      <p><strong>${escapeHtml(messages.signedInAs)}:</strong> ${escapeHtml(session.member.identity.email)}</p>
      ${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ""}
      <h2>${escapeHtml(messages.members)}</h2>
      <table><thead><tr><th>${escapeHtml(messages.members)}</th><th>${escapeHtml(messages.role)}</th></tr></thead><tbody>${memberRows || `<tr><td colspan="2">—</td></tr>`}</tbody></table>
      <h2>${escapeHtml(messages.invitations)}</h2>
      <form method="post" action="/members/invite">
        <input type="hidden" name="lang" value="${language}">
        <label for="invite-email">${escapeHtml(messages.inviteEmail)}</label>
        <input id="invite-email" name="email" type="email" required autocomplete="email">
        <button type="submit">${escapeHtml(messages.createInvitation)}</button>
      </form>
      <table><thead><tr><th>${escapeHtml(messages.inviteEmail)}</th><th>${escapeHtml(messages.role)}</th><th></th></tr></thead><tbody>${invitationRows || `<tr><td colspan="3">—</td></tr>`}</tbody></table>
      <p><a href="/app?lang=${language}">${escapeHtml(messages.workspaceTitle)}</a></p>
      <form method="post" action="/auth/logout?lang=${language}"><button type="submit">${escapeHtml(messages.signOut)}</button></form>
      ${renderLanguageLinks(language, messages, "/members")}
    </main>
  </body>
</html>`;
}

export function renderMembershipDeniedPage(language: Language): string {
  const messages = messagesFor(language);
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><title>${escapeHtml(messages.appName)} · ${escapeHtml(messages.membershipTitle)}</title>${pageStyles()}</head><body><main><h1>${escapeHtml(messages.membershipTitle)}</h1><p role="alert">${escapeHtml(messages.membershipDenied)}</p><p><a href="/app?lang=${language}">${escapeHtml(messages.workspaceTitle)}</a></p><form method="post" action="/auth/logout?lang=${language}"><button type="submit">${escapeHtml(messages.signOut)}</button></form>${renderLanguageLinks(language, messages, "/members")}</main></body></html>`;
}

export function renderRejectionPage(language: Language, reason: "admission_required" | "invalid_identity"): string {
  const messages = messagesFor(language);
  const description = reason === "admission_required" ? messages.rejectionDescription : messages.admissionRequired;
  return `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(messages.appName)} · ${escapeHtml(messages.rejectionTitle)}</title>
    ${pageStyles()}
  </head>
  <body>
    <main>
      <p class="hint">${escapeHtml(messages.appName)}</p>
      <h1>${escapeHtml(messages.rejectionTitle)}</h1>
      <p role="alert">${escapeHtml(description)}</p>
      <p><a href="/?lang=${language}">${escapeHtml(messages.signIn)}</a></p>
      <form method="post" action="/auth/logout?lang=${language}">
        <button type="submit">${escapeHtml(messages.signOut)}</button>
      </form>
      ${renderLanguageLinks(language, messages)}
    </main>
  </body>
</html>`;
}

function cookies(request: IncomingMessage): Readonly<Record<string, string>> {
  const header = request.headers?.cookie ?? "";
  return Object.fromEntries(header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return [];
    try {
      return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
    } catch {
      return [];
    }
  }));
}

async function requestBody(request: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      body += String(chunk);
      if (body.length > 8192) {
        settled = true;
        reject(new Error("request body too large"));
      }
    });
    request.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(body);
      }
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

type RequestFields = Readonly<Record<string, string>>;

function requestFields(body: string, contentType: string | undefined): RequestFields | null {
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json") {
    try {
      const value: unknown = JSON.parse(body);
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
      const fields: Record<string, string> = {};
      for (const [key, field] of Object.entries(value)) {
        if (typeof field !== "string") return null;
        fields[key] = field;
      }
      return fields;
    } catch {
      return null;
    }
  }
  const form = new URLSearchParams(body);
  return Object.fromEntries(form.entries());
}

function jsonResponse(response: ServerResponse, statusCode: number, value: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function cookieHeader(token: string, production: boolean): string {
  return `tracegarden_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax${production ? "; Secure" : ""}`;
}

type BetterAuthDatabase = DatabaseBoundary & {
  betterAuth(environment: Record<string, string | undefined>): Promise<BetterAuthRuntime>;
};

function hasBetterAuth(value: DatabaseBoundary): value is BetterAuthDatabase {
  return "betterAuth" in value && typeof value.betterAuth === "function";
}

function hasMembershipStore(value: AdmissionStore): value is AdmissionStore & MembershipStore {
  return typeof value.createInvitation === "function"
    && typeof value.revokeInvitation === "function"
    && typeof value.listInvitations === "function"
    && typeof value.listMembers === "function"
    && typeof value.assignMemberRole === "function"
    && typeof value.listAuditRecords === "function";
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (value) headers.set(name, value);
  }
  return headers;
}

function setResponseHeaders(response: ServerResponse, headers: Headers): void {
  for (const [name, value] of headers) {
    if (name !== "set-cookie") response.setHeader(name, value);
  }
  const headersWithCookies = headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headersWithCookies.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie") as string] : []);
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
}

export async function createWebRuntime(options: WebOptions = {}): Promise<WebRuntime> {
  const environment = options.environment ?? process.env;
  const database = options.database ?? createDatabase(environment);
  if (environment.NODE_ENV === "production" && database.kind === "memory") {
    throw new Error("Memory database is not allowed in production");
  }
  const identityAdapter = options.identityAdapter ?? createIdentityAdapter(environment);
  let admissionStore: AdmissionStore;
  let clusterScopeStore: ClusterScopeStore;
  if (environment.NODE_ENV === "production") {
    if (options.admissionStore || options.identityAdapter || database.kind !== "postgres" || !database.admission) {
      await database.close();
      throw new Error("Production admission must use the database-owned durable store");
    }
    if (options.clusterScopeStore || !database.clusterScope) {
      await database.close();
      throw new Error("Production Cluster scope must use the database-owned durable store");
    }
    admissionStore = database.admission;
    clusterScopeStore = database.clusterScope;
  } else {
    admissionStore = options.admissionStore ?? database.admission ?? new MemoryAdmissionStore();
    clusterScopeStore = options.clusterScopeStore ?? database.clusterScope ?? new MemoryClusterScopeStore();
  }
  if (environment.NODE_ENV === "production") {
    const bootstrapIdentity = configuredBootstrapIdentity(environment);
    const betterAuthURL = environment.BETTER_AUTH_URL?.trim();
    let secureBaseURL = false;
    try {
      secureBaseURL = new URL(betterAuthURL ?? "").protocol === "https:";
    } catch {
      secureBaseURL = false;
    }
    if (bootstrapIdentity.issuer !== GOOGLE_ISSUER) {
      await database.close();
      throw new Error("Production bootstrap identity must use the Google issuer");
    }
    if (!secureBaseURL) {
      await database.close();
      throw new Error("BETTER_AUTH_URL must be HTTPS in production");
    }
  }
  await database.migrate();
  if (!(await database.ping())) {
    await database.close();
    throw new Error("Tracegarden database readiness check failed");
  }
  let betterAuthRuntime: BetterAuthRuntime | undefined;
  if (environment.NODE_ENV === "production") {
    if (identityAdapter.kind !== "google") {
      await database.close();
      throw new Error("Production identity must use Google OAuth");
    }
    if (!hasBetterAuth(database)) {
      await database.close();
      throw new Error("Production authentication requires Better Auth with PostgreSQL");
    }
    try {
      betterAuthRuntime = await database.betterAuth(environment);
    } catch (error) {
      await database.close();
      throw error;
    }
  }

  const status = async (): Promise<StatusResponse> => {
    const databaseReady = await database.ping();
    return {
      service: "tracegarden-web",
      status: state(databaseReady),
      checks: {
        database: state(databaseReady),
        migrations: "ready",
      },
    };
  };

  type RequestSession = Readonly<{
    session: AuthenticatedSession | null;
    rejection?: "admission_required" | "invalid_identity";
  }>;

  const sessionForRequest = async (request: IncomingMessage): Promise<RequestSession> => {
    if (betterAuthRuntime) {
      const authenticated = await betterAuthRuntime.session(requestHeaders(request));
      if (!authenticated) return { session: null };
      const identity: ExternalIdentity = {
        issuer: GOOGLE_ISSUER,
        subject: authenticated.subject,
        email: authenticated.user.email,
        displayName: authenticated.user.name?.trim() || authenticated.user.email,
      };
      const admission = await admissionStore.admit(identity, {
        token: authenticated.token,
        expiresAt: authenticated.expiresAt,
      });
      return admission.admitted
        ? { session: admission.session }
        : { session: null, rejection: admission.reason };
    }
    const token = cookies(request).tracegarden_session;
    return { session: token ? await admissionStore.getSession(token) : null };
  };

  const hasWorkspaceAccess = (session: AuthenticatedSession | null): boolean => {
    if (!session) return false;
    try {
      requireCapability(session.member, capabilities.workspaceRead);
      return true;
    } catch {
      return false;
    }
  };
  const membershipStore = hasMembershipStore(admissionStore) ? admissionStore : null;

  const scopeForSession = (session: AuthenticatedSession): Promise<ClusterScope | null> => clusterScopeStore.get(session.member.workspaceId);

  const sendJson = (response: ServerResponse, statusCode: number, payload: unknown): void => {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
  };

  const formScopeInput = (form: URLSearchParams): Record<string, unknown> => {
    const clusterId = form.get("clusterId")?.trim();
    return {
      ...(clusterId ? { clusterId } : {}),
      name: form.get("name") ?? "",
      endpoint: form.get("endpoint") ?? "",
      namespaces: (form.get("namespaces") ?? "").split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
      resourceKinds: form.getAll("resourceKinds"),
    };
  };

  const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";
      const language = parseLanguage(requestUrl.searchParams.get("lang"));
      const authOrigin = environment.BETTER_AUTH_URL ?? `http://${request.headers?.host ?? "localhost"}`;
      if (betterAuthRuntime && requestUrl.pathname.startsWith("/api/auth/")) {
        const body = method === "GET" || method === "HEAD" ? undefined : await requestBody(request);
        const authRequest = new Request(new URL(request.url ?? "/", authOrigin).toString(), {
          method,
          headers: requestHeaders(request),
          ...(body === undefined ? {} : { body }),
        });
        const authResponse = await betterAuthRuntime.handler(authRequest);
        response.statusCode = authResponse.status;
        setResponseHeaders(response, authResponse.headers);
        response.end(await authResponse.text());
        return;
      }
      if ((requestUrl.pathname === "/auth/login" || requestUrl.pathname === "/login") && method === "POST") {
        if (identityAdapter.kind !== "local") {
          response.statusCode = 405;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: "google_login_required" }));
          return;
        }
        const form = new URLSearchParams(await requestBody(request));
        const selected = form.get("identity") ?? "";
        const selectedLanguage = parseLanguage(form.get("lang"));
        const identity = identityAdapter.resolve(selected);
        if (!identity) {
          response.statusCode = 403;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(renderRejectionPage(selectedLanguage, "invalid_identity"));
          return;
        }
        const admission = await admissionStore.admit(identity);
        if (!admission.admitted) {
          response.statusCode = 403;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(renderRejectionPage(selectedLanguage, admission.reason));
          return;
        }
        response.statusCode = 303;
        response.setHeader("location", `/app?lang=${selectedLanguage}`);
        response.setHeader("set-cookie", cookieHeader(admission.session.token, environment.NODE_ENV === "production"));
        response.end();
        return;
      }
      if (requestUrl.pathname === "/auth/logout" && method === "POST") {
        if (betterAuthRuntime) {
          const authResponse = await betterAuthRuntime.handler(new Request(new URL("/api/auth/sign-out", authOrigin).toString(), {
            method: "POST",
            headers: requestHeaders(request),
          }));
          response.statusCode = 303;
          response.setHeader("location", `/?lang=${language}`);
          setResponseHeaders(response, authResponse.headers);
          response.end();
          return;
        }
        response.statusCode = 303;
        response.setHeader("location", `/?lang=${language}`);
        response.setHeader("set-cookie", "tracegarden_session=; Max-Age=0; HttpOnly; Path=/; SameSite=Lax");
        response.end();
        return;
      }
      if ((requestUrl.pathname === "/auth/login" || requestUrl.pathname === "/login") && method === "GET") {
        const current = await status();
        response.statusCode = current.status === "ready" ? 200 : 503;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(renderLoginPage(language, current.checks.database === "ready", identityAdapter));
        return;
      }
      if (requestUrl.pathname === "/auth/google" && method === "GET" && betterAuthRuntime) {
        const authResponse = await betterAuthRuntime.handler(new Request(new URL("/api/auth/sign-in/social", authOrigin).toString(), {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ provider: "google", callbackURL: `/app?lang=${language}` }),
        }));
        if (!authResponse.ok) {
          response.statusCode = authResponse.status;
          response.setHeader("content-type", authResponse.headers.get("content-type") ?? "application/json; charset=utf-8");
          response.end(await authResponse.text());
          return;
        }
        const payload = await authResponse.json() as { url?: unknown };
        if (typeof payload.url !== "string") throw new Error("Better Auth did not return a Google authorization URL");
        response.statusCode = 302;
        response.setHeader("location", payload.url);
        setResponseHeaders(response, authResponse.headers);
        response.end();
        return;
      }
      if (requestUrl.pathname === "/api/cluster" || requestUrl.pathname === "/api/cluster/scope") {
        const lookup = await sessionForRequest(request);
        if (!lookup.session || !hasWorkspaceAccess(lookup.session)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        if (method === "GET") {
          sendJson(response, 200, { scope: await scopeForSession(lookup.session) });
          return;
        }
        if (method !== "POST" && method !== "PUT") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        if (!hasClusterConfigureCapability(lookup.session.member)) {
          sendJson(response, 403, { error: "missing_capability", capability: capabilities.clusterConfigure });
          return;
        }
        let input: unknown;
        try {
          input = JSON.parse(await requestBody(request)) as unknown;
        } catch {
          sendJson(response, 400, { error: "invalid_json" });
          return;
        }
        try {
          const scope = await configureClusterScope(lookup.session.member, clusterScopeStore, input);
          sendJson(response, 200, { scope });
        } catch (error: unknown) {
          if (error instanceof ClusterScopeValidationError) {
            sendJson(response, 400, { error: "invalid_cluster_scope", issues: error.issues });
            return;
          }
          throw error;
        }
        return;
      }
      if (requestUrl.pathname === "/cluster/configure" && method === "POST") {
        const lookup = await sessionForRequest(request);
        const messages = messagesFor(language);
        if (!lookup.session) {
          response.statusCode = lookup.rejection ? 403 : 302;
          if (lookup.rejection) {
            response.setHeader("content-type", "text/html; charset=utf-8");
            response.end(renderRejectionPage(language, lookup.rejection));
          } else {
            response.setHeader("location", `/?lang=${language}`);
            response.end();
          }
          return;
        }
        const scope = await scopeForSession(lookup.session);
        if (!hasClusterConfigureCapability(lookup.session.member)) {
          response.statusCode = 403;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(renderApplicationPage(language, lookup.session, scope, { error: messages.clusterConfigurationDenied }));
          return;
        }
        const form = new URLSearchParams(await requestBody(request));
        try {
          await configureClusterScope(lookup.session.member, clusterScopeStore, formScopeInput(form));
          response.statusCode = 303;
          response.setHeader("location", `/app?lang=${language}&cluster=saved`);
          response.end();
        } catch (error: unknown) {
          response.statusCode = 400;
          response.setHeader("content-type", "text/html; charset=utf-8");
          const errorMessage = error instanceof ClusterScopeValidationError
            ? `${messages.clusterConfigurationInvalid} ${error.issues.map((issue) => issue.message).join(" ")}`
            : messages.clusterConfigurationUnavailable;
          response.end(renderApplicationPage(language, lookup.session, scope, { error: errorMessage }));
        }
        return;
      }

      const isMembershipPage = requestUrl.pathname === "/members"
        || requestUrl.pathname === "/members/invite"
        || requestUrl.pathname === "/members/revoke"
        || requestUrl.pathname === "/members/role";
      const invitationMatch = requestUrl.pathname.match(/^\/api\/invitations\/([^/]+)(?:\/revoke)?$/);
      const memberRoleMatch = requestUrl.pathname.match(/^\/api\/members\/([^/]+)\/role$/);
      const isMembershipApi = requestUrl.pathname === "/api/members"
        || requestUrl.pathname === "/api/invitations"
        || requestUrl.pathname === "/api/audit"
        || Boolean(invitationMatch)
        || Boolean(memberRoleMatch);
      if (isMembershipPage || isMembershipApi) {
        const lookup = await sessionForRequest(request);
        const isApi = isMembershipApi;
        if (!lookup.session) {
          if (isApi) jsonResponse(response, lookup.rejection ? 403 : 401, { error: lookup.rejection ?? "unauthorized" });
          else {
            response.statusCode = 302;
            response.setHeader("location", `/?lang=${language}`);
            response.end();
          }
          return;
        }
        if (!hasWorkspaceAccess(lookup.session) || !hasCapability(lookup.session.member, capabilities.membershipManage)) {
          if (isApi) jsonResponse(response, 403, { error: "forbidden", capability: capabilities.membershipManage });
          else {
            response.statusCode = 403;
            response.setHeader("content-type", "text/html; charset=utf-8");
            response.end(renderMembershipDeniedPage(language));
          }
          return;
        }
        if (!membershipStore) {
          jsonResponse(response, 503, { error: "membership_store_unavailable" });
          return;
        }
        if (isApi && method === "GET") {
          if (requestUrl.pathname === "/api/members") jsonResponse(response, 200, { members: await membershipStore.listMembers() });
          else if (requestUrl.pathname === "/api/invitations") jsonResponse(response, 200, { invitations: await membershipStore.listInvitations() });
          else if (requestUrl.pathname === "/api/audit") jsonResponse(response, 200, { records: await membershipStore.listAuditRecords() });
          else jsonResponse(response, 404, { error: "not_found" });
          return;
        }
        if (isApi && method !== "POST" && method !== "PATCH" && method !== "DELETE") {
          jsonResponse(response, 405, { error: "method_not_allowed" });
          return;
        }
        const body = method === "GET" || method === "HEAD" ? "" : await requestBody(request);
        const fields = requestFields(body, request.headers?.["content-type"]);
        const responseLanguage = !isApi && fields?.lang ? parseLanguage(fields.lang) : language;
        const actor = lookup.session.member;
        try {
          if (requestUrl.pathname === "/api/invitations" && method === "POST") {
            if (!fields?.email) {
              jsonResponse(response, 400, { error: "invalid_request" });
              return;
            }
            const invitation = await membershipStore.createInvitation(fields.email, actor);
            jsonResponse(response, 201, { invitation });
            return;
          }
          if (invitationMatch && (method === "DELETE" || (method === "POST" && requestUrl.pathname.endsWith("/revoke")))) {
            const invitation = await membershipStore.revokeInvitation(invitationMatch[1] ?? "", actor);
            if (!invitation) {
              jsonResponse(response, 404, { error: "invitation_not_found_or_unusable" });
              return;
            }
            jsonResponse(response, 200, { invitation });
            return;
          }
          if (memberRoleMatch && (method === "PATCH" || method === "POST")) {
            const role = fields?.role;
            if (!role || !isRole(role)) {
              jsonResponse(response, 400, { error: "invalid_role" });
              return;
            }
            const member = await membershipStore.assignMemberRole(memberRoleMatch[1] ?? "", role, actor);
            if (!member) {
              jsonResponse(response, 404, { error: "member_not_found" });
              return;
            }
            jsonResponse(response, 200, { member });
            return;
          }
          if (isApi) {
            jsonResponse(response, 404, { error: "not_found" });
            return;
          }
          if (requestUrl.pathname === "/members" && method === "GET") {
            response.statusCode = 200;
            response.setHeader("content-type", "text/html; charset=utf-8");
            const notice = requestUrl.searchParams.get("notice");
            const messages = messagesFor(language);
            const noticeText = notice === "created" ? messages.invitationCreated : notice === "revoked" ? messages.invitationRevoked : notice === "role" ? messages.roleChanged : undefined;
            response.end(renderMembersPage(language, lookup.session, await membershipStore.listMembers(), await membershipStore.listInvitations(), noticeText));
            return;
          }
          if (!fields) {
            response.statusCode = 400;
            response.setHeader("content-type", "text/html; charset=utf-8");
            response.end(renderMembershipDeniedPage(responseLanguage));
            return;
          }
          if (requestUrl.pathname === "/members/invite" && method === "POST") {
            if (!fields.email) throw new Error("invalid request");
            await membershipStore.createInvitation(fields.email, actor);
            response.statusCode = 303;
            response.setHeader("location", `/members?lang=${responseLanguage}&notice=created`);
            response.end();
            return;
          }
          if (requestUrl.pathname === "/members/revoke" && method === "POST") {
            if (!fields.invitationId || !await membershipStore.revokeInvitation(fields.invitationId, actor)) throw new Error("invitation unavailable");
            response.statusCode = 303;
            response.setHeader("location", `/members?lang=${responseLanguage}&notice=revoked`);
            response.end();
            return;
          }
          if (requestUrl.pathname === "/members/role" && method === "POST") {
            if (!fields.memberId || !fields.role || !isRole(fields.role) || !await membershipStore.assignMemberRole(fields.memberId, fields.role as Role, actor)) throw new Error("member unavailable");
            response.statusCode = 303;
            response.setHeader("location", `/members?lang=${responseLanguage}&notice=role`);
            response.end();
            return;
          }
          response.statusCode = 404;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(renderMembershipDeniedPage(responseLanguage));
        } catch (error) {
          const message = error instanceof Error && /valid email|invalid request|unavailable/.test(error.message) ? error.message : "membership operation failed";
          if (isApi) jsonResponse(response, 400, { error: message });
          else {
            response.statusCode = 400;
            response.setHeader("content-type", "text/html; charset=utf-8");
            response.end(renderMembershipDeniedPage(responseLanguage));
          }
        }
        return;
      }
      if (method !== "GET") {
        response.statusCode = 405;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (requestUrl.pathname === "/health/live") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ service: "tracegarden-web", status: "alive" }));
        return;
      }
      if (requestUrl.pathname === "/health/startup" || requestUrl.pathname === "/health/readiness" || requestUrl.pathname === "/api/status") {
        const current = await status();
        response.statusCode = current.status === "ready" ? 200 : 503;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify(current));
        return;
      }
      if (requestUrl.pathname === "/api/session") {
        const lookup = await sessionForRequest(request);
        if (!lookup.session || !hasWorkspaceAccess(lookup.session)) {
          response.statusCode = 401;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        response.statusCode = 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ member: lookup.session.member }));
        return;
      }
      if (requestUrl.pathname === "/app") {
        const lookup = await sessionForRequest(request);
        if (!lookup.session) {
          if (lookup.rejection) {
            response.statusCode = 403;
            response.setHeader("content-type", "text/html; charset=utf-8");
            response.end(renderRejectionPage(language, lookup.rejection));
          } else {
            response.statusCode = 302;
            response.setHeader("location", `/?lang=${language}`);
            response.end();
          }
          return;
        }
        if (!hasWorkspaceAccess(lookup.session)) {
          response.statusCode = 403;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(renderRejectionPage(language, "admission_required"));
          return;
        }
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(renderApplicationPage(language, lookup.session, await scopeForSession(lookup.session), {
          saved: requestUrl.searchParams.get("cluster") === "saved",
        }));
        return;
      }
      if (requestUrl.pathname === "/") {
        const current = await status();
        const lookup = await sessionForRequest(request);
        response.statusCode = current.status === "ready" ? 200 : 503;
        response.setHeader("content-type", "text/html; charset=utf-8");
        if (lookup.rejection) {
          response.statusCode = 403;
          response.end(renderRejectionPage(language, lookup.rejection));
        } else if (lookup.session && !hasWorkspaceAccess(lookup.session)) {
          response.statusCode = 403;
          response.end(renderRejectionPage(language, "admission_required"));
        } else {
          response.end(lookup.session
            ? renderApplicationPage(language, lookup.session, await scopeForSession(lookup.session))
            : renderLoginPage(language, current.checks.database === "ready", identityAdapter));
        }
        return;
      }
      response.statusCode = 404;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: "not_found" }));
    })().catch((error: unknown) => {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: "service_unavailable" }));
      console.error(error instanceof Error ? error.message : "web request failed");
    });
  };

  const server = createServer(requestHandler);
  const port = options.port ?? Number(environment.PORT ?? "3000");
  const host = options.host ?? environment.HOST ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return {
    server,
    status,
    close: async () => {
      await database.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
