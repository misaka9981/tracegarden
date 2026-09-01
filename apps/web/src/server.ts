import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { state, type StatusResponse } from "../../../packages/contracts/src/index.js";
import { createDatabase, type DatabaseBoundary } from "../../../packages/db/src/index.js";
import { messagesFor, parseLanguage, type Language, type Messages } from "../../../packages/i18n/src/index.js";

type WebOptions = Readonly<{
  database?: DatabaseBoundary;
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

export function renderStatusPage(language: Language, databaseReady: boolean): string {
  const messages = messagesFor(language);
  return `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(messages.appName)} · ${escapeHtml(messages.statusTitle)}</title>
    <style>
      :root { color-scheme: light; font-family: system-ui, sans-serif; background: #f6f7f9; color: #1f2937; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
      main { width: min(42rem, calc(100% - 2rem)); background: white; border: 1px solid #d9dee8; border-radius: 1rem; padding: 2rem; box-shadow: 0 0.5rem 2rem #1f29371a; }
      h1 { margin-top: 0; }
      p { line-height: 1.6; }
      ul { display: grid; gap: 0.75rem; list-style: none; margin: 1.5rem 0; padding: 0; }
      li { display: flex; justify-content: space-between; border-bottom: 1px solid #edf0f5; padding: 0.75rem 0; }
      .ready { color: #087f5b; }
      .not-ready { color: #b42318; }
      nav { display: flex; gap: 1rem; }
      nav a { color: #175cd3; }
      .hint { color: #667085; font-size: 0.9rem; }
    </style>
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
      <nav aria-label="${escapeHtml(messages.language)}">
        <a href="/?lang=zh-CN" lang="zh-CN">${escapeHtml(messages.chinese)}</a>
        <a href="/?lang=en" lang="en">${escapeHtml(messages.english)}</a>
      </nav>
    </main>
  </body>
</html>`;
}

export async function createWebRuntime(options: WebOptions = {}): Promise<WebRuntime> {
  const environment = options.environment ?? process.env;
  const database = options.database ?? createDatabase(environment);
  if (environment.NODE_ENV === "production" && database.kind === "memory") {
    throw new Error("Memory database is not allowed in production");
  }
  await database.migrate();
  if (!(await database.ping())) {
    await database.close();
    throw new Error("Tracegarden database readiness check failed");
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

  const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "GET") {
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
      if (requestUrl.pathname === "/") {
        const language = parseLanguage(requestUrl.searchParams.get("lang"));
        const current = await status();
        response.statusCode = current.status === "ready" ? 200 : 503;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(renderStatusPage(language, current.checks.database === "ready"));
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
