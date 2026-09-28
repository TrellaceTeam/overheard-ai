/**
 * The server entry. TanStack Start resolves this file by name, in dev and in
 * the production build, so it runs once per process and never in the browser.
 *
 * Two things are added to the default entry:
 *
 * 1. boot(). Migrations, seeding, recovery, the worker loop and the schedule
 *    sweep. Calling it at module scope means `vite dev` and `node server/index.mjs`
 *    start the same way, and each prints the same [boot] line.
 * 2. The loopback gate. Every request passes localRequestGuard before it
 *    reaches a route or a server function, and every response carries the
 *    anti-framing headers. See src/server/security.ts for the two attacks that
 *    survive binding to 127.0.0.1.
 */
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { boot, shutdown } from "./server/boot";
import { guarded } from "./server/security";

boot();

/**
 * Ctrl-C stops the loops before the process leaves, so nothing new is claimed.
 * A batch already in flight under Promise.allSettled is still abandoned and
 * boot recovery requeues it, so up to BATCH_SIZE billed answer calls can be
 * asked and paid for again. That is the same guarantee a power cut gets.
 *
 * This handler does not exit. Leaving the process is the entry's job:
 * server/index.mjs closes the listener and exits, and `vite dev` does the same.
 * Exiting here would race them both and cut the close short.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shutdown();
  });
}

const handler = createStartHandler(defaultStreamHandler);

export default {
  fetch(request: Request): Promise<Response> {
    return guarded(request, () => handler(request));
  },
  /** server/index.mjs puts the same gate in front of the static files. */
  guarded,
};
