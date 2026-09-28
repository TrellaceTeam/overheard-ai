# Architecture

How Overheard AI is put together, for anyone about to change it. The README explains what it
does. The decisions behind the shape are in [docs/decisions](decisions/).

Everything runs in one process. A TanStack Start application on Vite serves the browser,
the server functions in `src/server/api/` are the only way the browser reaches data, and a
worker loop and a schedule tick live on timers inside the same process. The database is one
SQLite file.

```
  src/routes/**            screens, browser
  src/components/**        components, browser
  src/lib/**               pure helpers, shared by both sides
  src/server/api/<area>.ts server functions, the only server modules a route may import
  src/server/api/ops/**    what those server functions do, including the edits a screen makes
  src/server/logic/**      the run: planning, claiming, storing, recounting, recovery, scoring
  src/server/worker/**     the loop, the provider adapters, extraction
  src/server/db/**         driver adapter, migrations, seed catalogue
```

Import protection in `vite.config.ts` fails the dev server and the build if anything under
`src/server/` reaches the client module graph, with one exemption for the server function
files themselves, because a route has to import those to call them. The compiler replaces
each handler with a fetch, so the file that ships holds the call signature and none of the
code behind it.

## The request gate

Every request, pages and static files included, passes `guarded` in `src/server/security.ts`
before anything else sees it. The dev server runs it from `src/server.ts`; `npm start` runs
the same function from `server/index.mjs` in front of the static file server.

- The `Host` must be `localhost`, `127.0.0.1` or `::1`. That refuses DNS rebinding, where a
  page on another site resolves its own name to this machine.
- A mutating request that sends an `Origin` must send this machine's. That refuses a form or
  fetch posted from another site. TanStack Start's own CSRF check sits behind it for server
  functions.
- Every response carries `X-Frame-Options: DENY` and `frame-ancestors 'none'`. A framed page's
  requests really are same-origin, so neither test above could refuse a clickjacked click.

The server binds `127.0.0.1` and does not read `HOST`. The `Host` test stops a browser, not a
client on the network that can send any header it likes, so a wider bind would expose
everything.

## The database

One SQLite file in WAL mode, opened through the adapter below, migrated at boot. Sixteen
tables:

| Table | What it holds |
| --- | --- |
| `models` | The assistant catalogue: provider, model id, tier, prices, whether it can search, and which models can be used as extractors. Seeded and refreshed on every boot, except `is_active`, which belongs to the user. |
| `projects` | One brand being tracked, with the optional brand description from setup, which nothing reads back. Several projects share a file, plus at most one built-in demo project (ADR 0006), flagged and generated, never run. |
| `app_state` | One row of install-wide facts: the tutorial state, the run size limit (`max_planned_calls`) and each provider's calls in flight (`max_inflight_<provider>`, null for the default). |
| `brands` | The target brand and its competitors, with name variants and domains. |
| `prompts` | The buyer questions, with a `category` that is the tag (the server requires one whenever it creates or retags a question; the column itself is nullable), an `iterations` count, an on/off flag and an archived flag. A run asks a prompt only when it is on and not archived. |
| `project_models` | Which assistants a project asks. |
| `runs` | One measurement. Status, planned, completed and failed call counts, a config snapshot, whether it was a mock run, and when it was scored. |
| `run_tasks` | One row per answer, and the answer text itself. |
| `extractions` | The structured read of one answer, with the raw JSON kept. |
| `brand_observations` | One row per brand named in one answer: position, mention type, citation and evidence. |
| `run_metrics` | The scored output of a run, at two scope levels. |
| `perception_summaries` | The current qualitative read per project and assistant, plus a merged row. |
| `schedules` | One optional schedule per project. |
| `usage_events` | Tokens, search calls and estimated cost per call, for the spend line. A prompt results summary is logged here with no run, and so is starter prompt generation, which the setup screen asks for before the project exists. |
| `answer_summaries` | The on-demand prose summary of one prompt's answers in one run, with the answer count it was built from and its logged cost. |
| `prompt_summaries` | The on-demand prose summary of one prompt's answers across runs, newest run first under a character budget: what it read, how many answers the prompt had then, and its logged cost. Its `created_at` is when the answers were read, so a run finishing later marks it outdated. |

### Why the answer text lives on `run_tasks`

There is no `answers` table. `run_tasks.answer_text` is the answer.

The task row is what the worker claims, locks, retries and reports on, and the second phase
of the task re-reads the stored answer instead of trusting what it was handed. With the text
one join away, the claim, the retry and the extraction would each need that join, and "the
answer is stored before extraction starts" would be a two-table invariant instead of a
one-row one. That ordering is what makes a failed extraction cost one cheap call to redo,
not the expensive searching answer call again.

`run_tasks.question_text` is denormalised for the same reason, and it keeps a run readable as
its own record.

### Deleting a prompt, a brand or a run

- Deleting a prompt deletes its tasks, and with them their extractions and observations, and
  its metric rows, then re-scores every finished run that asked it and recounts every run
  still going. An answer with no prompt cannot be classified as self-referenced or not
  (ADR 0005), so none is kept. The `prompt_id` foreign key still reads `ON DELETE SET NULL`,
  but the tasks are gone before it could fire. Archiving is the alternative the UI offers
  first: the prompt leaves the library and its answers keep counting.
- Deleting a brand deletes its metric rows and re-scores its finished runs. Its observations
  stay, with the raw name and no brand, and finalisation skips them.
- Deleting a run is refused while any of its calls is with a provider. The call is billed
  either way, and its answer would land on a run that no longer exists.

## A run

### Statuses

`runs.status` is one of `queued`, `running`, `completed`, `partial`, `failed`, `cancelled`.

`run_tasks.status` is one of `queued`, `in_flight`, `answered`, `extracting`, `done`,
`failed`.

```
  queued ──claim──> in_flight ──answer stored──> answered
                        │                           │
                        │ error                     claim
                        v                           v
                     (backoff)                  extracting
                        │                           │
                        └──> queued                 │ observations written
                                                    v
                                                  done
    any phase, attempts exhausted or 4xx  ───────> failed
```

One function does both claims: a `queued` task becomes `in_flight`, an `answered` task
becomes `extracting`. Attempts are counted **per phase**, not per task: storing the answer
resets `attempts` to 0 in the same statement, so a failing extraction gets its own budget
and never buys the answer again. The ceiling is 2 per phase: one automatic retry, then the
run page's Retry button, because a third attempt spends real money on a call that has
already failed twice.

The plan for a run, its prompts times their iterations times its assistants, comes from
`planCounts` in `src/lib/run-plan.ts`. The Run button's preview, the run itself and the setup
wizard all use it, so what is shown and what is spent cannot differ.

### Run status is derived, never incremented

`updateRunProgress` recounts the tasks and writes the counters. It never adds one to
anything, so a recount is idempotent and the numbers cannot drift from the rows they
describe. The rules, in order:

1. `cancelled` is sticky. A late answer cannot resurrect a run the user stopped, though its
   counters and timestamps are still refreshed.
2. Anything still pending means `running`.
3. A perception-only run: no successful perception answer means `failed`, any failure
   alongside a success means `partial`, otherwise `completed`.
4. A measured run: no successful measured answer means `failed`, any measured failure
   alongside a success means `partial`, otherwise `completed`.

Every write that changes a task's status recounts the run it belongs to: the worker after a
claimed batch, the recovery sweep for each run it fails a task in, cancel, retry and a prompt
delete. Reading a run does not write to it; `getRunDetail` is a read.

### Cancel

`cancelRun` sets the run to `cancelled` and fails every task that is `queued` or `answered`
at that moment. A task already talking to a provider is left alone, so the answer that was
paid for is still stored when it lands. The claimer takes no new work from a run that is not
`queued` or `running`, so the run stops after the calls in flight finish.

A task whose answer lands after the cancel is `answered` with its attempts back at 0, which
the claimer and the exhaustion sweep both skip. The recovery sweep closes those rows, at
boot and on every pass, and recounts the run.

## The two-phase task

Every answer costs two provider calls, and they are different kinds of call.

1. **Ask.** The buyer question goes to the chosen assistant, always with web search. An
   answer that shows no completed search fails and is retried. The answer text, token counts,
   latency and estimated cost are stored on the task, and the task becomes `answered`.
2. **Extract.** A second, cheap model call turns that stored text into structured output:
   the brands named, their positions in any ranked list, the answer format, and which links
   were cited. That produces one `extractions` row and one `brand_observations` row per
   brand named, and the task becomes `done`.

The app chooses the extractor, cheapest first, among the providers you have a key for. The
extraction request carries the JSON shape it must be answered in, enforced the provider's own
way: OpenAI strict structured outputs, a Gemini response schema, an Anthropic forced tool
use. The setup check's extractor probe sends the same shape, so a passing check predicts a
passing run. A model that still returns the wrong shape sends the same stored answer up the
extraction ladder inside the one claim: the same provider's next tier up, then the cheapest
keyed extractor, two escalations at most, each billed and logged like any extraction call.
A reply that stopped at the output token cap climbs the same way and is never parsed, because
a cut-off JSON list can still parse with brands missing. Only a ladder whose every reader
fails fails the task: with `EXTRACTION_TRUNCATED` when every reader ran out of tokens, shown as
"The model that reads answers ran out of room", and with `EXTRACTION_UNREADABLE` otherwise,
shown as "We could not read this answer". Retry on either walks the ladder again.

Perception tasks use the same two phases with different prompts: the answer is read into
four sections instead of mined for brands, and a database trigger refuses any brand
observation written against a perception task. A perception answer names the brand's
customers and partners, and treating them as rivals would fill the competitor list.

## The worker loop

An in-process singleton held on `globalThis`, so a dev hot reload cannot leave two loops
claiming from one queue. It starts at boot, ticks every 2 seconds while there is claimable
work, backs off to 15 seconds when a pass finds nothing, and is woken immediately when a run
is created. The timers are unref'd, so they never hold the process open by themselves.

One pass is: reap, claim, call, persist, finalise.

- **Batch size is 15**, the overall concurrency ceiling. The batch is claimed, then run
  through `Promise.allSettled`, and nothing waits after the claim: a task held locked while
  it waited would cross the stale-lock window, be reclaimed mid-flight, and the provider
  would be called twice. The limit therefore lives inside the claim. `claimTasks` applies
  **per-provider in-flight caps** (OpenAI 6, Anthropic 6, Google 3, summing to the batch),
  counting an answer call against its model's provider and an extraction call against the
  provider of the extractor the worker will actually call, and it skips, without locking, a
  candidate whose provider is at its cap. Account settings saves a cap per provider in
  `app_state`, from 1 to 15 because no batch could reach more, and each pass reads it, so a
  change needs no restart. A valid `OVERHEARD_MAX_INFLIGHT_<PROVIDER>` wins over the saved
  cap, and the saved cap over the default (`worker/concurrency.ts`). A cap set too high costs
  429s and backoff, never money, because providers do not bill a rejected request. Google
  publishes no numeric rates, so its 3 is a judgement call.
- **Claiming is one write transaction** opened with `BEGIN IMMEDIATE`: select, status
  change, lock stamp and attempt increment together. SQLite has no `FOR UPDATE SKIP LOCKED`,
  and taking the write lock before the read is the equivalent.
- **The lock stamp** is the process id plus a boot id, because process ids get reused and a
  crashed run's stale lock would otherwise read as this process's own.
- **Timeout is 240 seconds** per call, and 360 for an attempt whose previous one timed out:
  an identical retry of a slow call fails identically. Retryable failures (429, 5xx,
  network) back off exponentially. A 4xx that a retry cannot change, such as exceeding the
  search cap, fails immediately.
- A pass has a time budget, checked between batches, so one pass can overrun it by at most
  one call's budget.
- When a run's tasks are drained, the pass enriches newly discovered brands, finalises the
  run, and tracks the top competitor if the project has none yet. Each run is scored on its
  own, so one run's failure is logged and cannot stop another from being scored.

## Recovery

At boot there is no live provider call in this process, whatever the table says, so:

- Every `in_flight` task returns to `queued`, regardless of lock age.
- Every `extracting` task returns to `answered`, never to `queued`. Its answer has already
  been bought, and requeuing it would pay for the answer twice.
- Claimable tasks on a cancelled run are closed.
- Tasks that have used their attempts are failed.

While the process is running, the same sweep applies to locks older than seven minutes: the
longest call budget, 360 seconds, plus a minute of margin. `STUCK_LOCK_MS` is derived from
`MAX_CALL_TIMEOUT_MS`, and a test holds it above that, because a younger lock may be a call
still in flight.

This is why **one process per database file** matters. A second process would see the first
one's healthy in-flight work as stale and claim it, and both would pay.

## Finalisation, and the oracle fixtures

`finalizeRun` deletes and rewrites every `run_metrics` row for a run inside one transaction,
so running it twice writes the same rows. It does not decide the run status;
`updateRunProgress` does that, and finalisation calls it first. The rows carry the run's own
creation time, so re-scoring an old run leaves it where it was on the trend. A drained run is
finalised even when nothing in it was done, to zero rows, because `finalised_at` is what tells
the run page to stop waiting for statistics.

Metrics are written at two scope levels: level 0 is one row per (assistant, prompt, brand),
level 1 is one row per brand with assistant and prompt null, meaning across the whole run.
The denominator on a row is the number of `done`, non-perception answers in its scope. The
counting rule is applied before aggregation: observations are folded into one row per
(answer, brand) first, so an answer that names a brand three times counts one mention.

A row exists only for a brand that was named in its scope. The screens add level 0 rows up
with `aggregate` in `src/lib/metrics.ts`, so the answers they count are those in (assistant,
prompt) scopes where at least one brand was named. A scope in which no answer named any brand
adds nothing to any denominator. That is a choice: an answer that names no brand says nothing
about how one brand compares with another, and counting it would lower every brand's rate by
the same amount. An answer whose only brand has since been deleted counts the same way.

Several of the rules are easy to get subtly wrong and impossible to spot by eye, because
every wrong number still looks plausible. So the TypeScript is not checked by reading the
SQL. `scripts/finalize-run-oracle/` runs a reference implementation in PL/pgSQL inside an
embedded PostgreSQL and dumps input rows and expected output rows as JSON fixtures under
`src/server/logic/__fixtures__/finalize-run/`. The TypeScript has to reproduce them, to 4
decimal places for rates and 2 for ranks.

What those fixtures pin down: a brand mentioned but never ranked has a null average rank and
a rank spread of `0.00`, not null; a brand mentioned and never cited has a
link-when-mentioned rate of `0.0000`, not null; and finalisation does not gate on run status,
so a run whose perception task is still extracting still gets its full set of measured rows.
The stored average rank is part of that output; no screen shows it. Read
`scripts/finalize-run-oracle/README.md` before changing anything there, and `CONTRIBUTING.md`
for when regenerating is and is not appropriate.

## The scheduler

A second timer in the same process: one tick at startup, then every 60 seconds.

There is no cron expression. A schedule is a cadence (daily, weekly, monthly), a day, an
hour and a named timezone, and `hour_utc` is the local hour in that timezone despite its name.
The next occurrence is computed with `Intl.DateTimeFormat`, not a date library. Two DST
rules, both tested: a local hour that does not exist fires at the first valid instant after
it, and an ambiguous local hour takes the first of its two occurrences.

Catch-up after downtime fires **once**, not once per missed occurrence. Overlap is guarded
three ways: a reentrancy flag in the process, a check for a run already going for that
project, and a conditional update inside `BEGIN IMMEDIATE`, so two ticks cannot both claim
the same due schedule. A skipped tick records its reason on the schedule row.

## The driver adapter

`src/server/db/driver.ts` is a small synchronous surface: `exec`, `prepare(sql)` with
`run`/`get`/`all`, `transaction(fn)`, `immediateTransaction(fn)` and `close`. Behind it is
`node:sqlite` under Node and `bun:sqlite` under Bun, chosen at runtime by a `typeof Bun`
check and a dynamic import, so one build runs under either. Both drivers model their API on
better-sqlite3, so the adapter is thin and query code never learns which runtime it is on.

There is no native npm addon: no node-gyp, no Python, no C++ toolchain, no prebuilt binary to
match against a new Node major. See [ADR 0001](decisions/0001-runtime-and-sqlite-driver.md).

Two details the adapter is strict about:

- **Booleans are not a bindable type.** `node:sqlite` refuses one and `bun:sqlite` quietly
  converts it to 0 or 1, which would make a missed conversion work under Bun and throw under
  Node. The adapter refuses a boolean in its parameter type and again at runtime, and every
  flag goes through `toSqlBool()`.
- **`immediateTransaction` exists separately** because claiming work reads a set of rows and
  then writes exactly those rows. With a deferred `BEGIN`, a second writer can slip in
  between and the lock upgrade fails as `SQLITE_BUSY`.

Schema changes are numbered SQL files under `src/server/db/migrations/`, applied by a runner
that records applied versions in `_schema_migrations` inside the database itself. A
migration that has shipped is never edited: somebody's database has already applied it.
