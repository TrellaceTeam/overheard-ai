-- Failed tasks carry a typed failure code beside the detail text: the code is
-- what classification matches on, and the error column keeps the scrubbed
-- provider message for the technical-detail disclosure. Null on any task that
-- has not failed, and on rows written before this column existed, which
-- lib/failure-reasons classifies from the prose.

ALTER TABLE run_tasks ADD COLUMN failure_code TEXT;
