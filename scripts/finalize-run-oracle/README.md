# finalize_run oracle

`finalize_run` is where a subtle arithmetic difference would be invisible: every number it
writes looks plausible. So `src/server/logic/finalize-run.ts` is not checked by reading SQL.
It has to reproduce fixtures produced by running a **reference implementation in PL/pgSQL**
inside an embedded PostgreSQL.

The fixtures live in the app tree, at `src/server/logic/__fixtures__/finalize-run/`. This
folder holds the generator that writes them. `docs/architecture.md` explains where
finalisation sits in a run.

## Why it has its own package.json

The generator needs `@electric-sql/pglite`, PostgreSQL 18 compiled to wasm. That is a 100 MB
development-only dependency with no place in the app's dependency tree, where every user
would install it. The `package-lock.json` in this folder pins it.

Nothing in `npm run build`, `npm test` or `npm run dev` touches this folder.

## Regenerating the fixtures

```sh
cd scripts/finalize-run-oracle
npm install          # once, and only when regenerating
node smoke.mjs       # checks the embedded Postgres has what the functions need
npm run oracle
```

`npm run oracle` writes one JSON file per case into `src/server/logic/__fixtures__/finalize-run/`
and a summary into `out/summary.json`. It needs no network after the install and no API
keys. Regenerate only when the expected numbers should change; `CONTRIBUTING.md` says when
that is.

## What is in here

| File | What it is |
|---|---|
| `oracle.mjs` | Builds each dataset, calls `finalize_run`, and dumps the input and expected rows. |
| `sql/schema.sql` | The tables the functions read and write, in PostgreSQL types. |
| `sql/functions.sql` | The reference `finalize_run`, `update_run_progress` and the perception trigger. |
| `smoke.mjs` | A feature check for the embedded Postgres (`gen_random_uuid`, `stddev_pop`, `count(*) filter`). |

## Fixture shape

```jsonc
{
  "name": "counting-rule",
  "description": "...",
  "input":    { "run_tasks": [...], "brand_observations": [...], ... },
  "expected": { "run_metrics": [...], "runs": [...] }
}
```

`expected` is what real PostgreSQL produced. Rates arrive as fixed-scale strings from
`numeric(5,4)`, such as `"0.6667"`, and Overheard AI stores REAL, so the tests compare with
`toBeCloseTo(value, 4)`.

## What the fixtures pin down

Read this before changing `finalize-run.ts`.

1. A brand mentioned but never ranked has `avg_rank`, `best_rank` and `worst_rank` null, and
   `rank_stddev` `0.00`, not null, because `round(coalesce(a.sd, 0), 2)` wraps only the
   standard deviation. See the `assistant-alpha` / `top search platforms` / Acme Analytics
   row in `repeat-finalize-idempotent.json`.
2. `link_when_mentioned` is `0.0000`, not null, whenever a brand was mentioned and never
   cited. It could only be null with zero mentions, and a brand with no mentions has no row.
3. `finalize_run` does not gate on run status. With the perception task still `extracting`,
   the run reads `running` with `finished_at` null, and every `run_metrics` row is still
   written. See `expected.while_perception_still_extracting` in `perception-excluded.json`.
4. `top3` is `max(case when o.position <= 3 then 1 else 0 end)` over the group, not
   `min(position) <= 3` afterwards. The two agree on every input, because `min` skips nulls
   and a null comparison falls to the `else 0` arm. `finalize-run.ts` uses the `max` form.
5. Every rate comes back from `numeric(5,4)` as a fixed-scale string such as `"0.6667"`.
   `finalize-run.ts` stores a REAL rounded to 4 places, and the tests compare with
   `toBeCloseTo(value, 4)`.

## Where the oracle schema differs from Overheard AI's

It lists `blocked` in the `run_tasks.status` CHECK, because `update_run_progress` counts it
and the `mixed-failure` case needs it. Overheard AI has no `blocked` status: in a fixture, a
`blocked` task is a `failed` task. Both are terminal, both are left out of every denominator,
and both count into `failed_calls`.

## Data

Fictional throughout: Acme Analytics, Northwind Metrics, Contoso Insights, Fabrikam Labs and
Globex Search, on assistants `assistant-alpha` and `assistant-beta` from a provider called
`example`. Citation URLs use `example.invalid`. No real brand, prompt, answer or observation
appears anywhere in this folder.
