-- Two columns on runs, and one rebuild of run_metrics.
--
-- runs.mock records whether the answers in a run came from the offline provider
-- seam. It has to be stored, because the seam is read from the environment at
-- call time: once the variable is unset the canned rows are indistinguishable
-- from measured ones, and they average into the same headline numbers.
--
-- runs.finalised_at records that a run has been scored. Run status cannot tell
-- a scored run from one that drained in a pass which never reached the scoring
-- step, and a cancelled run needs scoring too, so the worker's recovery net
-- looks for a missing stamp.
ALTER TABLE runs ADD COLUMN mock INTEGER NOT NULL DEFAULT 0 CHECK (mock IN (0,1));
ALTER TABLE runs ADD COLUMN finalised_at TEXT;

-- A run that already holds metric rows or a perception summary has been scored.
-- The backfill stops the recovery net from re-scoring, and re-paying for, every
-- run in an existing database.
UPDATE runs SET finalised_at = coalesce(finished_at, created_at)
 WHERE finalised_at IS NULL
   AND (EXISTS (SELECT 1 FROM run_metrics m WHERE m.run_id = runs.id)
     OR EXISTS (SELECT 1 FROM perception_summaries s WHERE s.run_id = runs.id));

-- run_metrics is rebuilt to swap its two delete rules.
--
-- brand_id becomes ON DELETE SET NULL. Under CASCADE, deleting one competitor
-- erases every metric row it produced. The answer count for a scope is built
-- from the rows loaded for it, so a scope whose surviving row was the deleted
-- brand's leaves the denominator, and every other brand's rates jump. SET NULL
-- matches brand_observations: the row stays in the denominator and is skipped
-- when the numbers are grouped by brand.
--
-- prompt_id becomes ON DELETE CASCADE. SET NULL collides with
-- run_metrics_scope_idx: the index coalesces a null prompt to the empty string,
-- so two level 0 rows that differ only by prompt become the same key once both
-- prompts are deleted, and SQLite aborts the second delete with a raw UNIQUE
-- constraint message the user can do nothing about. A level 0 row is a
-- per-prompt figure and means nothing once its prompt is gone, so it goes with
-- the prompt.
--
-- The order is what the SQLite manual prescribes: build the replacement
-- under a new name, copy, drop the original, then rename. Renaming the original
-- first would rewrite the REFERENCES clause in any child table to point at the
-- temporary name, and dropping it with foreign keys enforced would fire every
-- child's delete action. The runner turns enforcement off around the call.
CREATE TABLE run_metrics_new (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  project_id          TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  model_id            TEXT REFERENCES models(id),
  prompt_id           TEXT REFERENCES prompts(id) ON DELETE CASCADE,
  brand_id            TEXT REFERENCES brands(id) ON DELETE SET NULL,
  answers             INTEGER NOT NULL,
  mentions            INTEGER NOT NULL,
  ranked              INTEGER NOT NULL,
  citations           INTEGER NOT NULL,
  mention_rate        REAL    NOT NULL,
  rank_rate           REAL    NOT NULL,
  citation_rate       REAL    NOT NULL,
  link_when_mentioned REAL,
  avg_rank            REAL,
  best_rank           INTEGER,
  worst_rank          INTEGER,
  -- Population standard deviation, so a single sample gives 0.00.
  rank_stddev         REAL,
  share_of_voice      REAL,
  top_pick_share      REAL,
  top3_rate           REAL,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

INSERT INTO run_metrics_new SELECT * FROM run_metrics;

DROP TABLE run_metrics;

ALTER TABLE run_metrics_new RENAME TO run_metrics;

CREATE INDEX run_metrics_project_brand_created_idx ON run_metrics (project_id, brand_id, created_at DESC);
-- Nulls are distinct, so a plain unique constraint would not hold the aggregate
-- rows apart. Coalescing to a sentinel makes a duplicate scope row an error even
-- if finalisation's delete-before-insert is skipped.
CREATE UNIQUE INDEX run_metrics_scope_idx ON run_metrics (
  run_id,
  coalesce(model_id, ''),
  coalesce(prompt_id, ''),
  coalesce(brand_id, '')
);
