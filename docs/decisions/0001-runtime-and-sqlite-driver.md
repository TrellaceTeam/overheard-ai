# ADR 0001: Runtime and SQLite driver

Status: accepted 2026-09-22.

## Decision

- **Node.js (>= 22.13) is the primary runtime; npm is the primary package manager.**
  `package-lock.json` is committed. Bun (>= 1.2) is a supported second runtime, and CI boots
  the same build under it.
- **SQLite access goes through the runtime's built-in driver behind a thin adapter**
  (`src/server/db/driver.ts`): `node:sqlite` (`DatabaseSync`) under Node and `bun:sqlite`
  under Bun. The adapter exposes a small synchronous surface: `exec`,
  `prepare(sql).run/get/all`, `transaction(fn)` and `immediateTransaction(fn)`.
- **No native npm addon** (`better-sqlite3`, `@libsql/client` and the like) is used.

## Why

Install friction decides whether someone who clones the repository ever sees it run. Native
addons are the most common cause of a failed `npm install` on Windows and on a new Node major:
when no prebuilt binary matches, node-gyp needs Python and a C++ toolchain. `node:sqlite` and
`bun:sqlite` ship inside their runtimes, so there is nothing to download, compile or match
against an ABI. Both are modelled on `better-sqlite3`, so the adapter stays small.

Node is primary because every JavaScript developer already has it, and trying the tool should
not mean installing a second runtime.

## Consequences

- `node:sqlite` is "Stability: 1.1 - Active development" in Node 22 and 24, unflagged since
  22.13. Node prints an `ExperimentalWarning` at boot, and the README says so. The engine
  minimum is pinned and CI tests both drivers.
- Vite treats `node:sqlite` and `bun:sqlite` as externals. The adapter picks one with a
  `typeof Bun` check and a dynamic import, so one build runs under either runtime.
- `node:sqlite` refuses a boolean parameter and `bun:sqlite` converts it to 0 or 1, so the
  adapter refuses booleans in its parameter type and at runtime, and every flag goes through
  `toSqlBool()`.
- If `node:sqlite` develops a blocker, the adapter boundary lets `better-sqlite3` replace it
  without touching query code.
- `vite build` emits a fetch handler, not a listening server. `server/index.mjs` wraps it with
  srvx, which is already in the dependency tree, so `npm start` and `bun server/index.mjs` run
  the same `dist/`.
