-- A third state for prompts: archived.
--
-- On and off answer "ask this on the next run?". Archived answers "show this
-- in the library?". A prompt can be off and visible (running a different set
-- this week) or archived and out of sight (done with it, but its answers stay
-- and keep counting). A separate flag, not a synonym for is_active = 0, so
-- that restoring a hidden prompt brings back the on/off state it had.
--
-- Runs ask a prompt only when it is on AND not archived.
ALTER TABLE prompts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1));

-- Remove measured answers orphaned by a prompt delete.
--
-- Under 0001's ON DELETE SET NULL on run_tasks, deleting a prompt leaves its
-- answers with a null prompt_id. Those cannot be classified as self-referenced
-- or not, so a deleted brand-named question would keep counting in statistics,
-- against ADR 0005. The app's prompt delete removes a prompt's answers with
-- it, and this brings existing databases in line. Perception tasks have no
-- prompt and stay.
--
-- The runner turns foreign-key enforcement off around migrations, so the
-- children are deleted explicitly. Affected runs lose their metric rows and
-- their finalised_at stamp, which is the recovery net's signal to re-score
-- them from the surviving answers on the worker's next pass.

DELETE FROM run_metrics
 WHERE run_id IN (SELECT run_id FROM run_tasks WHERE prompt_id IS NULL AND is_perception = 0);

UPDATE runs SET finalised_at = NULL
 WHERE finalised_at IS NOT NULL
   AND id IN (SELECT run_id FROM run_tasks WHERE prompt_id IS NULL AND is_perception = 0);

DELETE FROM extractions
 WHERE run_task_id IN (SELECT id FROM run_tasks WHERE prompt_id IS NULL AND is_perception = 0);

DELETE FROM brand_observations
 WHERE run_task_id IN (SELECT id FROM run_tasks WHERE prompt_id IS NULL AND is_perception = 0);

DELETE FROM usage_events
 WHERE run_task_id IN (SELECT id FROM run_tasks WHERE prompt_id IS NULL AND is_perception = 0);

DELETE FROM run_tasks WHERE prompt_id IS NULL AND is_perception = 0;

-- Per-prompt metric rows with a null prompt_id, left by a prompt delete under
-- 0001's ON DELETE SET NULL on run_metrics. Level-1 aggregate rows have a null
-- model_id and are not touched.
DELETE FROM run_metrics WHERE prompt_id IS NULL AND model_id IS NOT NULL;
