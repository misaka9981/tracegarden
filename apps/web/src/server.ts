import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { state, type StatusResponse } from "../../../packages/contracts/src/index.js";
import { createDatabase, MemoryAdmissionStore, type DatabaseBoundary } from "../../../packages/db/src/index.js";
import {
  capabilities,
  configuredBootstrapIdentity,
  createIdentityAdapter,
  GOOGLE_ISSUER,
  requireCapability,
  type AdmissionStore,
  type AuthenticatedSession,
  type BetterAuthRuntime,
  type ExternalIdentity,
  type IdentityAdapter,
} from "../../../packages/identity/src/index.js";
import { messagesFor, parseLanguage, type Language, type Messages } from "../../../packages/i18n/src/index.js";

type WebOptions = Readonly<{
  database?: DatabaseBoundary;
  admissionStore?: AdmissionStore;
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

export function renderApplicationPage(language: Language, session: AuthenticatedSession): string {
  const messages = messagesFor(language);
  const member = session.member;
  const capabilityList = member.capabilities.map((capability) => `<li>${escapeHtml(capability)}</li>`).join("");
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
      <p>${escapeHtml(messages.welcome)}，${escapeHtml(member.identity.displayName)}。</p>
      <p><strong>${escapeHtml(messages.signedInAs)}:</strong> ${escapeHtml(member.identity.email)}</p>
      <h2>${escapeHtml(messages.capabilities)}</h2>
      <ul class="capabilities">${capabilityList}</ul>
      <form method="post" action="/auth/logout?lang=${language}">
        <button type="submit">${escapeHtml(messages.signOut)}</button>
      </form>
      ${renderLanguageLinks(language, messages, "/app")}
    </main>
  </body>
</html>`;
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

function cookieHeader(token: string, production: boolean): string {
  return `tracegarden_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax${production ? "; Secure" : ""}`;
}

type BetterAuthDatabase = DatabaseBoundary & {
  betterAuth(environment: Record<string, string | undefined>): Promise<BetterAuthRuntime>;
};

function hasBetterAuth(value: DatabaseBoundary): value is BetterAuthDatabase {
  return "betterAuth" in value && typeof value.betterAuth === "function";
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
  if (environment.NODE_ENV === "production") {
    if (options.admissionStore || options.identityAdapter || database.kind !== "postgres" || !database.admission) {
      await database.close();
      throw new Error("Production admission must use the database-owned durable store");
    }
    admissionStore = database.admission;
  } else {
    admissionStore = options.admissionStore ?? database.admission ?? new MemoryAdmissionStore();
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
        response.end(renderApplicationPage(language, lookup.session));
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
          response.end(lookup.session ? renderApplicationPage(language, lookup.session) : renderLoginPage(language, current.checks.database === "ready", identityAdapter));
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
