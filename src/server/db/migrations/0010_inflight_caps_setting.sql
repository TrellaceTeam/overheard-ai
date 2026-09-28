-- Each provider's calls in flight, install-wide settings on app_state,
-- editable in Account settings. The worker reads them every pass, so a change
-- needs no restart. NULL means the default in logic/claim-tasks.ts, so an
-- install that never chose a cap follows the default wherever it moves. A
-- valid OVERHEARD_MAX_INFLIGHT_<PROVIDER> variable wins over its column.
--
-- The CHECK mirrors the bounds the Account settings field validates (1 to
-- 15). Zero would leave a provider's tasks queued forever. Fifteen is the
-- worker's batch size: a pass claims at most fifteen tasks, so a higher cap
-- could never be reached.

ALTER TABLE app_state ADD COLUMN max_inflight_openai INTEGER
  CHECK (max_inflight_openai BETWEEN 1 AND 15);

ALTER TABLE app_state ADD COLUMN max_inflight_anthropic INTEGER
  CHECK (max_inflight_anthropic BETWEEN 1 AND 15);

ALTER TABLE app_state ADD COLUMN max_inflight_google INTEGER
  CHECK (max_inflight_google BETWEEN 1 AND 15);
