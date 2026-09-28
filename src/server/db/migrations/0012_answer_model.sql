-- The model version the provider reports for each answer, beside the catalogue
-- model it was asked of. A provider can move an id to a newer snapshot without
-- the id changing, and a trend compares like with like only while the version
-- behind it stays the same. Null on answers stored before this column existed,
-- and on answers whose provider reported no version.

ALTER TABLE run_tasks ADD COLUMN answer_model TEXT;
