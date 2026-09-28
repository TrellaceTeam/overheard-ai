-- The run call ceiling, an install-wide setting on app_state, editable in
-- Settings. planRun reads it per run, so a change needs no restart.
--
-- The default is tight. A large run is refused with a sentence that points at
-- Settings, so a person decides to raise the limit and an accidental run
-- cannot quietly spend real money. The wizard's default plan (5 prompts × 3
-- iterations × 3 assistants = 90 calls) sits far under it.
--
-- The CHECK mirrors the bounds the Settings field validates (1 to
-- 10,000,000).

ALTER TABLE app_state ADD COLUMN max_planned_calls INTEGER NOT NULL DEFAULT 1000
  CHECK (max_planned_calls BETWEEN 1 AND 10000000);
