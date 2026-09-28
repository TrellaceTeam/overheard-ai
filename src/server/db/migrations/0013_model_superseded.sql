-- A catalogue model a newer one replaced. It stays callable for the projects
-- that ask it, so their trends keep comparing like with like, and its past
-- answers keep their names. It is never preselected or auto-picked for a new
-- project. The seed sets it on every boot.

ALTER TABLE models ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1));
