import { createWebRuntime } from "./server.js";

try {
  await createWebRuntime();
  console.log(`Tracegarden web listening on ${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? "3000"}`);
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : "Tracegarden web failed to start");
  process.exitCode = 1;
}
