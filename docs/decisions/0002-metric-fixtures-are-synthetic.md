# ADR 0002: Metric parity fixtures are synthetic

Status: accepted 2026-09-22.

## Decision

`finalizeRun`, which turns a run's observations into its metric rows, is verified against
**synthetic fixtures** with obviously fictional brands ("Acme Analytics", "Northwind Metrics",
"Contoso Insights"). The expected values come from running a reference implementation in
PL/pgSQL, kept in `scripts/finalize-run-oracle/sql/`, against the same synthetic rows in an embedded
PostgreSQL (PGlite). The fixtures are plain JSON under `src/server/logic/__fixtures__/`.

## Constraints

- No real answer, brand, prompt or observation is ever copied into this repository, in
  fixtures, tests, docs or commit history.
- The fixtures cover the one-mention-per-answer counting rule, a brand absent from every
  answer (0%, not 100%), mixed success and failure denominators, the top-3 rate, citation
  attribution, perception tasks excluded from measured denominators, and a repeated
  finalisation writing identical rows.

## Why

The repository is public. Test data has to be readable, obviously fake and free of any
question about where it came from. Synthetic inputs with a SQL oracle give parity confidence
without real data.
