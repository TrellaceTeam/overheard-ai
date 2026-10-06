# ADR 0007: Subscription mode asks through the providers' own command line tools

Status: proposed 2026-10-06.

## Decision

A provider can be asked through the command line tool its maker ships, signed in with the
user's own plan, instead of through its API with a key. `OVERHEARD_ANTHROPIC_CLI` names
Claude Code's command (`claude`) and `OVERHEARD_OPENAI_CLI` names Codex's (`codex`). A provider
set this way never uses its API key. Google has no such route yet.

Everything else stays as it is: the queue, the claim caps, retries, extraction and its ladder,
scoring and the schedule. The switch happens at the one place every provider call passes,
`callProvider` in `src/server/worker/providers.ts`, where the mock seam already sits.
`src/server/worker/cli-provider.ts` runs the tool and reads its output.
`src/server/worker/cli-command.ts` finds the command and starts it without a shell.

Each call is one fresh process of the unmodified tool:

- in a new, empty temporary folder, deleted afterwards;
- with the question on stdin and the instructions in a file, never on the command line;
- with every provider API key variable removed from its environment, because Claude Code uses
  `ANTHROPIC_API_KEY` ahead of the plan sign-in and bills it at API rates, and Codex does the
  same with `CODEX_API_KEY`;
- with the tool's own context switched off as far as each allows. Claude Code runs with
  `--safe-mode` and a replaced system prompt. Codex runs with `--ignore-user-config`, replaced
  instructions, the skills list emptied and every feature but web search off;
- with web search the only tool on an answer, and no tool at all on an extraction.

Calls in subscription mode are logged at $0, and the catalogue prices reach the browser at
zero for those providers, so every estimate agrees with the spend the worker logs. Tokens are
still logged. A provider in subscription mode starts at 3 calls in flight.

Two failure codes are new. `CLI_SIGN_IN:<provider>` covers a command that cannot be found,
started or signed in, and is not retried. `PLAN_LIMIT:<provider>` covers a plan at its usage
limit, and is retried with the worker's backoff like a 429. Both read the tools' own wording,
which neither tool documents.

## Why

Founders who measure their own brand often pay for a Claude or ChatGPT plan already and have
no API key. The tools those plans include are the supported way to use a plan from a terminal,
and both are built to run non-interactively (`claude -p`, `codex exec`).

## Considered options

- **The desktop apps' scheduled tasks.** One agent session asking forty questions sees its own
  earlier answers, so the repeats stop being independent. It can skip or merge answers, and
  nothing checks that each one searched. The schedules also depend on the app being open.
- **Reading the plan's sign-in token and calling the API with it.** Anthropic forbids a third
  party collecting or using Claude.ai credentials, and it would break the first time a token
  format changed.
- **OpenAI's Sign in with ChatGPT for third-party apps.** A cleaner route for OpenAI, since the
  app keeps its own request code. It is a preview with its own OAuth flow, and it is a good
  next step once it is stable.
- **One extractor per provider in subscription mode.** Two readers split brand lists
  differently, which would skew one assistant against another. The project's extractor reads
  every answer, as on the API path.

## Consequences

- The measurement differs slightly from the API path. Claude Code searched once or twice per
  answer in testing, where the API path allows five. Codex adds its own agent instructions, which no
  setting removes, and the user's `~/.codex/AGENTS.md` when one exists. Account settings warns
  about that file. A trend that mixes API runs and plan runs mixes two measurements.
- The tools tell the model about the person running them, and neither has a setting that
  stops it. Claude Code adds the signed-in account's email to every conversation. Both add
  the date, the operating system and the working folder, whose path holds the user name, and
  Codex adds the time zone. A request logged with `OTEL_LOG_RAW_API_BODIES` shows Claude's
  exactly. The email can tilt answers in the user's own category. The README suggests signing
  the tool in with a separate account whose email doesn't name the company. Both tools keep a
  second sign-in apart when `CLAUDE_CONFIG_DIR` or `CODEX_HOME` points at another folder,
  and Overheard passes those variables through. The API path sends only the app's
  instructions and the question.
- Plan limits replace dollars, and neither company publishes them.
- Each tool's flags and output can change between versions. The parsers are lenient and
  tested against recorded output, and the setup check names a refused flag in its detail.
  Tested with Claude Code 2.1.284 and Codex 0.160.1. Codex features are switched off as
  `-c features.<name>=false`, which every version accepts, not `--disable <name>`, which
  rejects a name the version does not know.
- Plans are sized for one person's ordinary use. Anthropic allows a user to sign in to the
  unmodified Claude Code with their own plan, and does not allow a third party to route
  requests through plan credentials on its users' behalf. OpenAI recommends API keys for
  programmatic Codex use. The README sends users to both before they turn the mode on, and
  the mode is off unless a variable is set.
- On Windows, the `.cmd` launchers npm, pnpm and Yarn write are read for the program they
  start, because a `.cmd` file only runs under cmd.exe, whose quoting cannot carry a JSON
  schema safely. A batch file of any other shape is refused with a message that says to point
  the variable at the program itself.
