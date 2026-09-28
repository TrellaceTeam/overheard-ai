/**
 * Production entry.
 *
 * `vite build` emits a fetch handler at dist/server/server.js, not a listening
 * server. This file wraps that handler with srvx, the same runtime-agnostic
 * server TanStack Start already uses internally, so one build boots under both
 * Node and Bun. Run it with `npm start` (Node) or `bun server/index.mjs` (Bun).
 *
 * boot() is not called here. Importing the built entry runs it: migrations,
 * seeding, recovery, the worker loop and the schedule sweep, then the [boot]
 * line. That keeps `vite dev` and this file booting the same way, so a startup
 * bug cannot be dev-only or production-only.
 *
 * .env is read by whoever starts the process, not by this file. Bun reads it on
 * its own, `vite dev` reads it, and `npm start` passes Node
 * --env-file-if-exists=.env so the three agree. In all three a variable already
 * in the shell wins over the file. Running `node server/index.mjs` directly
 * skips .env, which is what you want when passing env inline.
 */
import { fileURLToPath } from "node:url";
import { serve } from "srvx";
import { serveStatic } from "srvx/static";

const clientDir = fileURLToPath(new URL("../dist/client", import.meta.url));
const { default: entry } = await import("../dist/server/server.js");

// Loopback only, and not configurable. The Host check stops a browser, not a
// client on the network that can send any Host it likes, so binding anything
// wider hands the network the whole API. `HOST` is not read: tcsh sets it to
// the machine's name, and other tools' docs tell people to export
// HOST=0.0.0.0.
const hostname = "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);

// The app's own gate (src/server/security.ts) runs ahead of the static files
// too, so a rebound page cannot read a built asset and every file carries the
// same security headers as a page. srvx's listening line and signal handlers
// are off: this file prints the one line and owns Ctrl-C.
const server = serve({
  hostname,
  port,
  silent: true,
  gracefulShutdown: false,
  middleware: [(request, next) => entry.guarded(request, next), serveStatic({ dir: clientDir })],
  fetch: (request) => entry.fetch(request),
});

await server.ready();
console.log(`Overheard AI listening on http://${hostname}:${port}`);

/**
 * Ctrl-C stops accepting requests and then leaves.
 *
 * The worker and schedule timers are unref'd, so they never hold the process
 * open by themselves. A task already talking to a provider is abandoned, and
 * boot recovery returns it to the queue next time. That is the same guarantee
 * a power cut gets, so it is not worth waiting for.
 */
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log("\nOverheard AI stopping");
    void Promise.resolve(server.close?.()).finally(() => process.exit(0));
  });
}
