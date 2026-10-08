-- Whether the Overheard AI icon rebuilds the app before starting it, when the
-- code in its folder is newer than the last build. An install-wide setting on
-- app_state, switched in Account settings.
--
-- server/index.mjs reads this column straight from the file, before boot,
-- because the app that would normally read it is the build in question. It
-- reads a missing column as on, so keep the name and the meaning.
--
-- On by default. A rebuild only follows a change already on disk, such as a
-- git pull, and never downloads anything.

ALTER TABLE app_state ADD COLUMN rebuild_on_open INTEGER NOT NULL DEFAULT 1
  CHECK (rebuild_on_open IN (0, 1));
