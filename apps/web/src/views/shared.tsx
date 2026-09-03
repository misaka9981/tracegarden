import { renderToString } from "hono/jsx/dom/server";
import type { Child } from "hono/jsx";
import { messagesFor, type Language, type Messages } from "../../../../packages/i18n/src/index.js";

const styles = `
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
      pre { background: #101828; color: #f8fafc; border-radius: 0.5rem; padding: 1rem; overflow: auto; white-space: pre-wrap; }
    `;

export function renderView(element: Child): string {
  return `<!doctype html>\n${renderToString(element)}`;
}

export function Page({ language, title, children }: { language: Language; title: string; children: Child }) {
  return <html lang={language}>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{messagesFor(language).appName} · {title}</title>
      <style>{styles}</style>
    </head>
    <body><main>{children}</main></body>
  </html>;
}

export function LanguageLinks({ language, messages, path = "/" }: { language: Language; messages: Messages; path?: string }) {
  const separator = path.includes("?") ? "&" : "?";
  return <nav aria-label={messages.language}>
    <a href={`${path}${separator}lang=zh-CN`} lang="zh-CN">{messages.chinese}</a>
    <a href={`${path}${separator}lang=en`} lang="en">{messages.english}</a>
  </nav>;
}

export function Check({ label, ready, messages }: { label: string; ready: boolean; messages: Messages }) {
  return <li><span>{label}</span><strong className={ready ? "ready" : "not-ready"}>{ready ? messages.ready : messages.notReady}</strong></li>;
}
