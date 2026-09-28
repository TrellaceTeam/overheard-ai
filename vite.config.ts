import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The SQLite driver ships inside the runtime: `node:sqlite` under Node and
 * `bun:sqlite` under Bun. Neither module exists on disk, so every bundling layer
 * must leave the specifier alone. See docs/decisions/0001.
 */
const sqliteExternals = ["node:sqlite", "bun:sqlite"];

/**
 * Nothing under src/server reaches the browser.
 *
 * TanStack Start's import protection walks the client module graph and fails
 * the build when any file under src/server appears in it. That keeps the
 * SQLite driver, the provider adapters and the key reader out of the bundle a
 * user downloads.
 *
 * The exception is the server function surface, src/server/api/*.ts. A route
 * has to import those to call them: the compiler replaces each handler with a
 * fetch, so the file that ships holds the call signature and none of the code
 * behind it. The operations live one directory down, in src/server/api/ops,
 * which is not exempt.
 *
 * `behavior: error` in dev as well as build. The dev default swaps the module
 * for a mock, which turns a mistake into a puzzling runtime failure later
 * instead of a red screen now.
 */
type StartOptions = NonNullable<Parameters<typeof tanstackStart>[0]>;

const importProtection: StartOptions["importProtection"] = {
  enabled: true,
  behavior: { dev: "error", build: "error" },
  client: {
    specifiers: [/^@\/server\/(?!api\/[^/]+$)/],
    files: ["**/*.server.*", "**/src/server/**"],
    excludeFiles: ["**/node_modules/**", "**/src/server/api/*.ts"],
  },
};

/**
 * Route tests sit beside the route they test, which is the repo's rule
 * everywhere else. The generator treats every file under src/routes as a route
 * and warns on each build about every one that is not, so it is told to skip
 * them. Nothing else in src/routes matches.
 */
const routeFileIgnorePattern = /\.test\.(ts|tsx)$/.source;

export default defineConfig({
  // Vite resolves the tsconfig `paths` map natively (8.3 and later), so `@/...`
  // needs no vite-tsconfig-paths plugin, and Vite warns on every start when
  // that plugin is registered.
  resolve: {
    tsconfigPaths: true,
  },
  // Otherwise Vite restarts the dev server and reloads the page whenever .env
  // changes, which throws away everything typed into setup. Nothing in the
  // browser reads import.meta.env, TanStack Start's own plugin still loads .env
  // into process.env at start, and src/server/worker/env-file.ts re-reads the
  // provider keys after that.
  envDir: false,
  // Local-first tool. Never listen on a public interface.
  //
  // PORT is read here as well as in server/index.mjs, so `PORT=3100 npm run dev`
  // listens on the same port the production entry would.
  server: {
    host: "127.0.0.1",
    port: Number(process.env["PORT"] ?? 3000),
  },
  preview: {
    host: "127.0.0.1",
    port: Number(process.env["PORT"] ?? 3000),
  },
  ssr: {
    external: sqliteExternals,
  },
  optimizeDeps: {
    exclude: sqliteExternals,
  },
  build: {
    rollupOptions: {
      external: sqliteExternals,
    },
  },
  plugins: [
    tailwindcss(),
    tanstackStart({ importProtection, router: { routeFileIgnorePattern } }),
    viteReact(),
  ],
});
