-- The brand description, and a usage kind for the call it feeds.
--
-- projects.description is the optional sentence the setup screen asks for:
-- what the brand does, for whom and where. It exists to tailor the generated
-- starter prompts, which read the setup screen's copy before the project
-- exists, so nothing reads the column back. Null when the user left it empty.
-- The cap is the setup screen's (DESCRIPTION_MAX_CHARS in lib/onboarding), and
-- a CHECK on an added column is tested against the rows already there, which
-- are all null.
ALTER TABLE projects ADD COLUMN description TEXT
  CHECK (description IS NULL OR length(description) <= 280);

-- Generating starter prompts is real spend on the user's keys, made before
-- the project it is for exists, so it is logged with no run under a kind of
-- its own. SQLite cannot widen a CHECK in place, so the log is rebuilt around
-- its rows, as in 0006 and 0007. Nothing references usage_events, and the
-- runner turns foreign-key enforcement off around migrations, so the swap is
-- safe.

CREATE TABLE usage_events_new (
  id             TEXT PRIMARY KEY,
  run_id         TEXT REFERENCES runs(id) ON DELETE CASCADE,
  run_task_id    TEXT REFERENCES run_tasks(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL
                   CHECK (kind IN ('answer','extraction','summary','prompt_summary','prompt_generation')),
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
