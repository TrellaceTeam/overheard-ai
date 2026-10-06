# Contributing

Thanks for looking. Overheard AI is a small codebase with a strict shape, so most of this
document is about the shape rather than about process.

## Setup

```sh
git clone https://github.com/TrellaceTeam/overheard-ai.git
cd overheard-ai
cp .env.example .env
npm install
npm run dev
```

Node 22.13 or newer, Node 24 preferred (`.node-version`). No key is needed to work on the
app: run with `OVERHEARD_MOCK_PROVIDERS=1` and every provider call is answered offline, so
you can exercise the whole run pipeline with no network and no spend.

Use a throwaway database while you work:

```sh
OVERHEARD_MOCK_PROVIDERS=1 DATABASE_PATH=./data/dev.db npm run dev
```

## The four commands

These have to be green before a pull request, and green again after review changes:

```sh
npm run lint         # biome check: lint rules and formatting
npm run typecheck    # tsc --noEmit, strict flags on
npm test             # vitest run
npm run build        # vite build, import protection on
```

`npm run format` rewrites the formatting and applies Biome's safe fixes. `server/index.mjs` is
the one source file the typecheck skips, because it imports the build output; CI boots it after
the build instead.

Bun is a supported second runtime, and CI checks it:

```sh
npm run test:bun     # bunx --bun vitest run
npm run build && npm run start:bun
```

## The mock provider seam

`OVERHEARD_MOCK_PROVIDERS=1` swaps every provider call for an offline seam: no network, no
keys, no spend, and a full run finishes in about two seconds. It is a development and CI
seam, not a user feature, and the app labels every screen while it is on. CI runs under it
(see `.github/workflows/ci.yml`). To walk the full flow by hand:

```sh
OVERHEARD_MOCK_PROVIDERS=1 DATABASE_PATH=./data/mock.db npm run dev
```

On Windows use `set` or `$env:`, or put the variable in `.env`. Point `DATABASE_PATH` at a
scratch file, never at a database with real measurements in it.

What it fabricates, and how that stays visible:

- The canned answers always cite the same URL, so the citation rate is effectively a
  constant, and "discovered in answers" always fills with the same three fictional brands.
  Do not judge a feature by those numbers.
- Runs made under the seam are stamped mock in the database, badged in the run list, and
  left out of the dashboard windows that would otherwise average them in with real
  measurements.
- The app says so on screen while the seam is on: a notice on the dashboard and run pages,
  and "mock provider" instead of "key found" in the keys panel. Keep those guards. They
  stop a mocked screenshot or a mocked database passing for real.

## Rules the build enforces

- **Browser code never imports from `src/server/**`.** The one exception is the server
  function surface, `src/server/api/<area>.ts`, which a route has to import to call it.
  Everything behind those files lives in `src/server/api/ops/` and is not exempt. Import
  protection fails the dev server and the build, not just review.
- **Strict TypeScript.** No `any` slipped in through a cast to make an error go away. If a
  cast is genuinely needed, write the reason above it.
- **SQLite access goes through the driver adapter** in `src/server/db/driver.ts`. No native
  addon, no second SQLite package. See
  [ADR 0001](docs/decisions/0001-runtime-and-sqlite-driver.md).
- **Schema changes are new numbered migrations** under `src/server/db/migrations/`. Never
  edit a migration that has shipped. Somebody's database has already applied it.

## Test conventions

- Tests are vitest and sit **beside the file they test**: `foo.ts` and `foo.test.ts` in the
  same directory. There is no `__tests__` tree.
- Server logic tests open an in-memory database (`openDatabase(":memory:")`), migrate it,
  and assert on rows. They do not mock the database.
- Provider calls are never made in a test. The offline seam in
  `src/server/worker/mock-provider.ts` is the seam to use. Subscription mode's tests start a
  stand-in script in place of `claude` or `codex`, never the real tool.
- A test that asserts on wording asserts on the wording a user sees, not on a class name.
- Prefer one test that fails for one reason over a test that asserts on a whole object.

## The finalize_run oracle

`finalize_run` computes every metric in the product, and a subtle arithmetic difference
there is invisible: every number it writes still looks plausible. So it is not verified by
reading the SQL. It is verified against fixtures produced by running a reference
implementation in PL/pgSQL inside an embedded PostgreSQL.

- The fixtures live at `src/server/logic/__fixtures__/finalize-run/` and are committed.
- The generator lives at `scripts/finalize-run-oracle/`, with its own `package.json` and its
  own lockfile, because it needs a 100 MB wasm PostgreSQL that has no business in the app's
  dependency tree. Nothing in `npm install`, `npm test` or `npm run build` touches it.

**Regenerate the fixtures only when the expected numbers should change**, which means: the
oracle SQL in `scripts/finalize-run-oracle/sql/` changed, or a new case was added to
`oracle.mjs`. Do not regenerate to make a failing test pass. A fixture diff is the one
signal that a metric changed meaning, and regenerating first destroys it.

```sh
cd scripts/finalize-run-oracle
npm install          # once, and only when regenerating
node smoke.mjs       # checks the embedded Postgres has what the functions need
npm run oracle
```

Read `scripts/finalize-run-oracle/README.md` before touching anything in that folder. `docs/architecture.md` explains where finalisation sits in a run.

## Forbidden vocabulary in fixtures and tests

Test data, fixtures, screenshots and documentation examples use **fictional brands only**:

- Acme Analytics
- Northwind Metrics
- Contoso Insights
- Fabrikam Labs
- Globex Search

Domains are `example.com` or `example.invalid`. Assistants in fixtures are
`assistant-alpha` and `assistant-beta` on a provider called `example`.

No real company, product, customer, person, email address or private domain goes into this
repository, in fixtures, tests, docs, comments or commit messages. A pull request that adds
a real brand name to test data will be asked to change it even if the test is otherwise
perfect. See [ADR 0002](docs/decisions/0002-metric-fixtures-are-synthetic.md). The one
exception is the built-in demo project and the tests of its generator, which use real brand
names with invented data. See
[ADR 0006](docs/decisions/0006-demo-project-uses-real-brand-names.md).

Never commit a key, a `.env`, or a database file. `.gitignore` covers `.env`, `data/`, `*.db`,
`*.db-wal` and `*.db-shm`, and it should stay that way.

## Pull requests

- One change per pull request, with the reason in the description.
- Say which of the four commands you ran and on which runtime.
- If you changed user-facing wording, quote the old and new strings.
- If you changed a decision recorded in `docs/decisions/`, amend the ADR in the same pull
  request rather than leaving the file wrong.

## Comments

A comment says what the code cannot: a constraint from outside it (a provider API quirk, a
runtime or driver behaviour, SQLite semantics, a spec), a threat the code defends against,
an invariant another module relies on, a unit, or the reason behind a choice a reader would
otherwise "fix".

- Write it in the present tense, about the code as it is. History belongs in commit messages,
  not beside the code.
- Do not restate the code, its name or its type.
- Put JSDoc on an exported function or type when its contract is not obvious from the
  signature. One sentence is usually enough.
- Keep the reason on a `biome-ignore`: it is the one suppression a reviewer has to trust.

If you find a comment that has stopped being true, fixing it is a welcome pull request on its
own.
