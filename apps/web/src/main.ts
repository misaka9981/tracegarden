import { createWebRuntime, type WebRuntime } from "./server.js";

let runtime: WebRuntime | undefined;
let shutdownRequested = false;
let shutdownPromise: Promise<void> | undefined;
const shutdown = (): void => {
  shutdownRequested = true;
  if (!runtime || shutdownPromise) return;
  shutdownPromise = runtime.close().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Tracegarden web failed to stop");
    process.exitCode = 1;
  });
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

try {
  runtime = await createWebRuntime();
  if (shutdownRequested) shutdown();
  else console.log(`Tracegarden web listening on ${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? "3000"}`);
  await shutdownPromise;
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : "Tracegarden web failed to start");
  process.exitCode = 1;
}
