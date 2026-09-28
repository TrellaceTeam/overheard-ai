-- Prompt results summaries: one on-demand paragraph per prompt, over what the
-- assistants have answered to it across every run, newest run first.
--
-- The cross-run sibling of answer_summaries (0006), bought the same way: from
-- the project's extraction model on the user's own keys, after the screen has
-- shown what it will cost. The product rule is one row per prompt, so asking
-- again replaces the row. It never counts in statistics.
--
-- A summary reads the newest runs that fit a character budget, so it can read
-- fewer answers than the prompt has. answer_count and run_count record what it
-- actually read, which is what its disclosure sentence states on every later
-- visit. total_answers records how many the prompt had when it was written,
-- which is what "N new answers since" counts from.
--
-- There is no question-text snapshot. A prompt's text is locked once any answer
-- is done (clone-to-edit), and when every answer is gone and the text unlocks,
-- rewording it deletes the row, so a summary cannot outlive a rewording.
-- Whether it is outdated is read from runs that finished after created_at,
-- which is when the answers were read, not when the reply came back: a run
-- that finishes while the call is out was not read, and must say so.
--
-- prompt_id cascades with the prompt: a summary of a deleted question has no
-- row left to render on. model_id does not cascade: the record of what wrote a
-- summary outlives a catalogue row being retired, same rule as usage_events.

CREATE TABLE prompt_summaries (
  id            TEXT PRIMARY KEY,
  project_id    TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prompt_id     TEXT    NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  summary       TEXT    NOT NULL,
  answer_count  INTEGER NOT NULL,
  run_count     INTEGER NOT NULL,
  total_answers INTEGER NOT NULL,
  model_id      TEXT REFERENCES models(id) ON DELETE SET NULL,
  cost_usd      REAL    NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE UNIQUE INDEX prompt_summaries_one_per_prompt ON prompt_summaries (prompt_id);
CREATE INDEX prompt_summaries_project_idx ON prompt_summaries (project_id);

-- A prompt results summary is real spend on the user's keys, so it belongs in
-- the usage log beside every other call. It belongs to no run, so it is logged
-- with run_id null under a kind of its own. SQLite cannot widen a CHECK in
-- place, so the log is rebuilt around its rows, as in 0006. Nothing references
-- usage_events, and the runner turns foreign-key enforcement off around
-- migrations, so the swap is safe.

CREATE TABLE usage_events_new (
  id             TEXT PRIMARY KEY,
  run_id         TEXT REFERENCES runs(id) ON DELETE CASCADE,
  run_task_id    TEXT REFERENCES run_tasks(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL CHECK (kind IN ('answer','extraction','summary','prompt_summary')),
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
