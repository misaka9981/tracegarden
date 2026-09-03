import { createWebApplication, type WebApplication } from "./server.js";

type BunServer = Readonly<{
  hostname: string;
  port: number;
  stop: () => Promise<void> | void;
}>;

type BunRuntime = Readonly<{
  version: string;
  serve: (options: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }) => BunServer;
}>;

const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
if (!bun) throw new Error("Tracegarden web requires Bun");
const environment = process.env;
const host = environment.HOST ?? "127.0.0.1";
const port = Number(environment.PORT ?? "3000");
let application: WebApplication | undefined;
let server: BunServer | undefined;
let shutdownRequested = false;
let shutdownPromise: Promise<void> | undefined;
let resolveStopped: (() => void) | undefined;
const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });

const shutdown = (): void => {
  shutdownRequested = true;
  if (!application || !server || shutdownPromise) return;
  shutdownPromise = (async () => {
    if (!server || !application) return;
    let stopPromise = Promise.resolve();
    let stopError: unknown;
    try {
      stopPromise = Promise.resolve(server.stop());
    } catch (error) {
      stopError = error;
    }
    try {
      await application.close();
    } finally {
      await stopPromise;
    }
    if (stopError) throw stopError;
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Tracegarden web failed to stop");
    process.exitCode = 1;
  }).finally(() => resolveStopped?.());
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

try {
  application = await createWebApplication();
  server = bun.serve({ hostname: host, port, fetch: application.app.fetch });
  application.markStarted(server.hostname, server.port);
  if (shutdownRequested) shutdown();
  else console.log(`Tracegarden web listening on ${server.hostname}:${server.port}`);
  await stopped;
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : "Tracegarden web failed to start");
  process.exitCode = 1;
  if (application && !shutdownPromise) {
    application.markFailed();
    try {
      await application.close();
    } catch {
      // Cleanup cannot mask the startup failure.
    }
  }
}
