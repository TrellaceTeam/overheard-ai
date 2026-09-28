-- Answer summaries: one on-demand "what did the assistants say" paragraph per
-- prompt per run.
--
-- A summary is bought from the project's extraction model on the user's own
-- keys, after the screen has shown what it will cost. It is stored, not
-- re-asked on every visit, and asking again replaces the row: the product rule
-- is one summary per (run, prompt). It never counts in statistics, so it gets
-- its own table, away from the metric path.
--
-- prompt_id cascades with the prompt: a summary of a deleted question has no
-- page left to render on. model_id does not cascade: the log of what wrote a
-- summary outlives a catalogue row being retired, same rule as usage_events.

CREATE TABLE answer_summaries (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prompt_id    TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  summary      TEXT    NOT NULL,
  -- How many answers the summary was built from, so a later visit can tell a
  -- summary of 4 answers from one of 25 without recounting the run.
  answer_count INTEGER NOT NULL,
  model_id     TEXT REFERENCES models(id) ON DELETE SET NULL,
  cost_usd     REAL    NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE UNIQUE INDEX answer_summaries_one_per_prompt ON answer_summaries (run_id, prompt_id);
CREATE INDEX answer_summaries_run_idx ON answer_summaries (run_id);

-- A summary call is real spend on the user's keys, so it belongs in the usage
-- log beside the answer and extraction calls it is priced like. SQLite cannot
-- widen a CHECK in place, so the log is rebuilt around its rows to admit the
-- summary kind. Nothing references usage_events, and the runner turns
-- foreign-key enforcement off around migrations, so the swap is safe.

CREATE TABLE usage_events_new (
  id             TEXT PRIMARY KEY,
  run_id         TEXT REFERENCES runs(id) ON DELETE CASCADE,
  run_task_id    TEXT REFERENCES run_tasks(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL CHECK (kind IN ('answer','extraction','summary')),
  provider       TEXT    NOT NULL,
  model_id       TEXT    NOT NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  search_calls   INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL    NOT NULL DEFAULT 0,
  cost_estimated INTEGER NOT NULL DEFAULT 1 CHECK (cost_estimated IN (0,1)),
  outcome        TEXT    NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

INSERT INTO usage_events_new
  (id, run_id, run_task_id, kind, provider, model_id, input_tokens, output_tokens,
   search_calls, cost_usd, cost_estimated, outcome, created_at)
SELECT id, run_id, run_task_id, kind, provider, model_id, input_tokens, output_tokens,
       search_calls, cost_usd, cost_estimated, outcome, created_at
  FROM usage_events;

DROP TABLE usage_events;
ALTER TABLE usage_events_new RENAME TO usage_events;

CREATE INDEX usage_events_run_idx ON usage_events (run_id);
