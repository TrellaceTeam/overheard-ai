-- Why the last retried attempt of a task failed, kept after the task finishes.
-- failure_code and error describe the task's current failure, and a success
-- clears them. These two keep the last retried attempt's code and scrubbed
-- detail beside them, in the same forms, so a call that failed once and then
-- answered still says why. Null on tasks that never retried, and on tasks
-- stored before these columns existed.

ALTER TABLE run_tasks ADD COLUMN retry_failure_code TEXT;
ALTER TABLE run_tasks ADD COLUMN retry_error TEXT;
