/**
 * Production entry, and what the Overheard AI icon runs.
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
 * The port is taken before that import, because boot recovery returns every
 * in-flight task to the queue, which is only right when no other process is
 * asking them. Binding first makes the port the lock: a second copy on the
 * same port stops before it opens the database.
 *
 * `--open` is how the icon starts it (scripts/shortcut.ts). If Overheard AI
 * already holds the port, it opens the browser and leaves. Otherwise it opens
 * the browser at once onto a page that waits while it starts, rebuilds first
 * when the code is newer than the build, and copies its output to
 * data/overheard.log, because an icon shows no console.
 *
 * .env is read by whoever starts the process, not by this file. Bun reads it on
 * its own, `vite dev` reads it, and `npm start` and the icon pass Node
 * --env-file-if-exists=.env so they agree. In all of them a variable already
 * in the shell wins over the file. Running `node server/index.mjs` directly
 * skips .env at start, which is what you want when passing env inline. Provider
 * keys alone are then re-read from .env while the app runs
 * (src/server/worker/env-file.ts), still behind any value the shell set.
 */
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve } from "srvx";
import { serveStatic } from "srvx/static";

const root = fileURLToPath(new URL("..", import.meta.url));
const clientDir = join(root, "dist", "client");
const builtEntry = join(root, "dist", "server", "server.js");
const logPath = join(root, "data", "overheard.log");

/** Everything `vite build` reads, so a pull, a branch switch or an edit counts. */
const BUILD_INPUTS = [
  "src",
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "tsconfig.json",
];

// Loopback only, and not configurable. The Host check stops a browser, not a
// client on the network that can send any Host it likes, so binding anything
// wider hands the network the whole API. `HOST` is not read: tcsh sets it to
// the machine's name, and other tools' docs tell people to export
// HOST=0.0.0.0.
const hostname = "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const url = `http://${hostname}:${port}/`;
const open = process.argv.includes("--open");

/**
 * Sent on every response, here and by src/server/security.ts, so a second
 * start can tell Overheard AI from another program on the port.
 */
const APP_HEADER = "x-overheard-ai";

/** What a request gets until the built app is loaded. */
let placeholder = () => page("Starting Overheard AI", "This takes a few seconds.", true);
let entry = null;

// The app's own gate (src/server/security.ts) runs ahead of the static files
// too, so a rebound page cannot read a built asset and every file carries the
// same security headers as a page. srvx's listening line and signal handlers
// are off: this file prints the one line and owns Ctrl-C.
const server = serve({
  hostname,
  port,
  silent: true,
  gracefulShutdown: false,
  middleware: [
    (request, next) => (entry ? entry.guarded(request, next) : placeholder()),
    serveStatic({ dir: clientDir }),
  ],
  fetch: (request) => entry.fetch(request),
});

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

try {
  await server.ready();
} catch (error) {
  if (error?.code !== "EADDRINUSE") throw error;
  await leaveThePortToItsOwner();
}

if (open) {
  copyOutputToLog();
  openInBrowser(url);
}

try {
  if (open && needsBuild()) {
    placeholder = () =>
      page(
        "Updating Overheard AI",
        "The code in this folder changed since the last build, so Overheard AI is rebuilding it. This can take up to a minute.",
        true,
      );
    await build();
  }
  ({ default: entry } = await import(pathToFileURL(builtEntry).href));
  console.log(`Overheard AI listening on ${url}`);
} catch (error) {
  if (!open) throw error;
  console.error(error);
  const reason = error instanceof Error ? error.message : String(error);
  placeholder = () =>
    page(
      "Overheard AI could not start",
      `${reason} The full log is in ${logPath}. Open Overheard AI again to retry.`,
      false,
    );
  // Long enough for the open tab to show the reason, then the port is free
  // for the next try.
  setTimeout(() => process.exit(1), 60_000);
}

/**
 * Another process holds the port. When it is Overheard AI, the icon's job is
 * done by opening the browser. Either way this process leaves without booting.
 */
async function leaveThePortToItsOwner() {
  if (await overheardAnswers()) {
    console.log(`Overheard AI is already running at ${url}`);
    if (open) openInBrowser(url);
    process.exit(open ? 0 : 1);
  }
  const message = `Port ${port} is in use by another program. Set PORT in .env to a free port, such as 3100, then open Overheard AI again.`;
  console.error(message);
  if (open) openInBrowser(notice("Overheard AI could not start", message));
  process.exit(1);
}

async function overheardAnswers() {
  try {
    // A cold `vite dev` renders its first page slowly, so the wait is generous.
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return response.headers.has(APP_HEADER);
  } catch {
    return false;
  }
}

/**
 * A missing build is always built. A stale one is rebuilt unless Account
 * settings turned that off.
 */
function needsBuild() {
  if (!existsSync(builtEntry)) return true;
  return rebuildAllowed() && newestSourceTime() > statSync(builtEntry).mtimeMs;
}

/**
 * Account settings' "Rebuild after the code changes" switch, read straight
 * from the database because the app that normally reads it is the build in
 * question. An unreadable database or a column older migrations lack reads as
 * on, the default.
 */
function rebuildAllowed() {
  const path = process.env.DATABASE_PATH ?? "./data/overheard.db";
  if (!existsSync(path)) return true;
  try {
    const require = createRequire(import.meta.url);
    const db = process.versions.bun
      ? new (require("bun:sqlite").Database)(path)
      : new (require("node:sqlite").DatabaseSync)(path);
    try {
      return (
        db.prepare("SELECT rebuild_on_open FROM app_state WHERE id = 1").get()?.rebuild_on_open !==
        0
      );
    } finally {
      db.close();
    }
  } catch {
    return true;
  }
}

function newestSourceTime() {
  let newest = 0;
  for (const name of BUILD_INPUTS) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const stats = statSync(path);
    if (!stats.isDirectory()) {
      newest = Math.max(newest, stats.mtimeMs);
      continue;
    }
    for (const file of readdirSync(path, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || /\.test\.tsx?$/.test(file.name)) continue;
      newest = Math.max(newest, statSync(join(file.parentPath, file.name)).mtimeMs);
    }
  }
  return newest;
}

async function build() {
  console.log("Rebuilding Overheard AI, because the code is newer than the last build");
  const vite = join(root, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [vite, "build"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) {
    throw new Error(
      "The rebuild failed. If you just updated Overheard AI, run npm install in its folder first.",
    );
  }
}

/**
 * Started from the icon there is no console to read, so everything this
 * process prints is copied to data/overheard.log, from the start of this run.
 * Only the process that holds the port gets here, so no two write the file.
 */
function copyOutputToLog() {
  mkdirSync(join(root, "data"), { recursive: true });
  const log = createWriteStream(logPath);
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      log.write(chunk);
      return write(chunk, ...rest);
    };
  }
}

/** The default browser, or nothing when BROWSER=none, as scripts and CI want. */
function openInBrowser(target) {
  if (process.env.BROWSER === "none") return;
  const windows = process.platform === "win32";
  // `start` is a cmd built-in. Its first quoted argument is a window title,
  // hence the empty one. Verbatim arguments keep Node from re-quoting the line.
  const [command, args] = windows
    ? ["cmd.exe", ["/d", "/c", `start "" "${target}"`]]
    : [process.platform === "darwin" ? "open" : "xdg-open", [target]];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: windows,
  });
  child.on("error", () => console.error(`Could not open a browser. Open ${target} yourself.`));
  child.unref();
}

/** A page for a browser to open when there is no server to show it. */
function notice(title, message) {
  const path = join(tmpdir(), "overheard-ai-notice.html");
  writeFileSync(path, html(title, message, false));
  return path;
}

function page(title, message, refresh) {
  return new Response(html(title, message, refresh), {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", [APP_HEADER]: "1" },
  });
}

function html(title, message, refresh) {
  const toHtml = (text) =>
    text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${refresh ? '<meta http-equiv="refresh" content="1">' : ""}
<title>${toHtml(title)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fff;
    color: #111; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 32rem; padding: 2rem; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 .5rem; }
  p { color: #555; margin: 0; overflow-wrap: anywhere; }
  @media (prefers-color-scheme: dark) { body { background: #0a0a0a; color: #eee; } p { color: #aaa; } }
</style>
</head>
<body><main><h1>${toHtml(title)}</h1><p>${toHtml(message)}</p></main></body>
</html>
`;
}
