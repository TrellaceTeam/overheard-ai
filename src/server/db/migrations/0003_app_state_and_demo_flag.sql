-- Install-wide state and the demo project flag.
--
-- app_state is a single row (the CHECK on id enforces it) of typed facts
-- about this install, not about one project. Install-wide facts are columns on
-- it. Its first column is the tutorial state ("not_started" | "in_setup" |
-- "done"): an existing database that already has projects is marked done here,
-- at migration time, so an upgrade never drops a returning user into the
-- tutorial.
--
-- projects.is_demo marks the built-in demo project (ADR 0006): real brand
-- names, invented data, browse-only. The partial unique index allows at most
-- one demo project per database.

CREATE TABLE app_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  tutorial_state TEXT NOT NULL DEFAULT 'not_started'
                   CHECK (tutorial_state IN ('not_started','in_setup','done')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

INSERT INTO app_state (id, tutorial_state, updated_at)
SELECT 1,
       CASE WHEN EXISTS (SELECT 1 FROM projects) THEN 'done' ELSE 'not_started' END,
       strftime('%Y-%m-%dT%H:%M:%fZ','now');

ALTER TABLE projects ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1));

CREATE UNIQUE INDEX projects_one_demo_idx ON projects (is_demo) WHERE is_demo = 1;
