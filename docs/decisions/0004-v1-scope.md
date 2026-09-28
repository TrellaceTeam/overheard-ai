# ADR 0004: What v1 includes and how it runs

Status: accepted 2026-09-22, revised 2026-09-26 to record the decisions as shipped.

Overheard AI v1 is a single-user tool on one machine. This record lists what it includes, how a
run behaves, and what is deliberately left out. `docs/architecture.md` explains the mechanics.

## Runs and tasks

- `runs.status` is one of `queued`, `running`, `completed`, `partial`, `failed`, `cancelled`.
  `run_tasks.status` is one of `queued`, `in_flight`, `answered`, `extracting`, `done`,
  `failed`.
- Cancel is a real action. It sets the run to `cancelled`, fails every `queued` and `answered`
  task, and lets a call already with a provider finish so the answer it paid for is kept.
  `cancelled` is sticky.
- Attempts are counted per phase: storing an answer resets them. The ceiling is 2 per phase,
  one automatic retry and then the run page's Retry button, because a third attempt spends
  money on a call that has already failed twice.
- An extraction that comes back in the wrong shape does not use the attempt budget. It walks
  the extraction ladder inside the same claim: the same provider's next tier up, then the
  cheapest extractor with a key, two escalations at most, each one billed and logged. An
  exhausted ladder fails the task with `EXTRACTION_UNREADABLE`, and Retry walks it again.
- A run is deleted only when none of its calls is with a provider.

## Data shapes

- The answer text lives on `run_tasks.answer_text`; there is no `answers` table. Every task
  carries its own `question_text`.
- `prompts.category` is the tag. There is no tags table. The starter tags are `visibility` and
  `comparison`.
- `run_metrics` holds two scope levels: level 0 per (assistant, prompt, brand) and level 1 per
  brand across the run. Rates are stored to 4 decimals and ranks to 2.
- Deleting a prompt deletes its tasks, answers and metric rows and re-scores its runs.
  Deleting a brand deletes its metric rows and re-scores its runs; its observations stay
  with their raw name and no brand.
- Several projects share one database. `/` opens the most recently updated project, or
  `/start` when there is none.
- Schema changes are numbered SQL migrations recorded in `_schema_migrations`.

## Provider keys and the setup check

- Keys come from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GOOGLE_API_KEY` (`GEMINI_API_KEY`
  is accepted for Google). At least one is needed to run. The app never writes `.env`.
- A key value never reaches the browser, the database or a log line.
- Creating a project needs a passing setup check for every chosen assistant and for the
  extractor. The check probes each exact model with web search forced, and the server runs it
  again at create time, refusing with `SETUP_CHECK_FAILED`.
- No OpenRouter in v1.

## Search and extraction

- Every answer must come from a web search. An answer with no completed search fails with
  `NO_WEB_SEARCH` and is retried. The search is forced wherever the API allows it: OpenAI
  with `tool_choice: "required"`, Anthropic with a forced tool and
  `allowed_callers: ["direct"]`. Gemini has no force mode, so its retry adds an instruction
  to search.
- Every extraction request carries its JSON schema in the provider's own form: OpenAI strict
  structured outputs, a Gemini response schema, an Anthropic forced tool use. The setup
  check's extractor probe sends the same shape.
- The extraction system prompt is a per-project setting, defaulting to the shipped text.

## Perception

- A project's first run also creates a perception run, which asks each assistant what it
  knows about the brand. Later runs are measured only; the dashboard offers a refresh.
- Perception answers never produce brand observations and never enter a rate.

## Worker

- One worker loop per process, held on `globalThis`, started at boot. It ticks every 2
  seconds while there is work and every 15 seconds when there is none, and a new run wakes it
  immediately.
- A pass claims up to 15 tasks, the sum of the per-provider in-flight caps (OpenAI 6,
  Anthropic 6, Google 3), overridable per provider in Account settings (1 to 15) and with
  `OVERHEARD_MAX_INFLIGHT_<PROVIDER>`, which wins over Account settings. The caps are applied
  inside the claim transaction, so a task over its provider's cap stays queued and no lock is
  held while it waits.
- Each call has 240 seconds, and 360 seconds when its previous attempt timed out.
- At boot every `in_flight` task returns to `queued` and every `extracting` task to
  `answered`. While running, a lock older than the longest call budget plus a minute is
  reclaimed. One process per database file.
- The run plan is computed by one function for the preview and for the run. A run above the
  install's run size limit (`app_state.max_planned_calls`, default 1,000 calls) is refused.
- `OVERHEARD_MOCK_PROVIDERS=1` returns canned answers and extractions with no network, no key
  and no spend. It is a test and demo seam, labelled on screen, never the default.

## Schedules

- One schedule per project: a cadence, a day, a local hour and a timezone. The hour is local
  to the timezone, despite the column name `hour_utc`.
- The scheduler ticks at startup and every 60 seconds. A schedule missed while the app was
  closed fires once. A nonexistent local hour fires at the first valid instant after it, and an
  ambiguous one takes the first occurrence.
- Schedules fire only while Overheard AI is running, and the schedule card says so.

## Screens

- `/start`, the two-step setup and the tutorial; `/projects/$id`, the dashboard;
  `/projects/$id/prompts`; `/projects/$id/competitors`; `/projects/$id/runs/$runId`;
  `/projects/$id/settings`; `/settings`, for key status, the setup check, the database file,
  the worker, the run size limit, each provider's calls in flight, and restoring the demo or
  re-running the tutorial.
- No landing page, accounts, billing, teams, key entry or sharing.
- Fonts come from `@fontsource-variable/inter` on npm. There is no runtime font request.
- The maintainer credit appears in the README, the LICENSE, the app menu and one
  dismissible line on the dashboard after the first completed run, and nowhere else. Example
  domains are under `example.com`.

## Security

- The server binds `127.0.0.1`. Every request needs a loopback `Host`, every mutating request
  a matching `Origin` when it sends one, and every response forbids framing.

## Deferred

A backup export button, a theme switcher, a diagnostics page, OpenRouter support and report
sharing.
