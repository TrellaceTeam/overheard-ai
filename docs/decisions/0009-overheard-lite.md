# ADR 0009: Overheard Lite asks through the person's own coding agent

Status: proposed 2026-10-23.

## Decision

`lite/` holds Overheard Lite, a skill a person copies into an empty folder and runs from Claude
Code or Codex, signed in with their own plan. It measures one assistant, the one that plan
covers, with no app, no API key and no Node.

ADR 0007 turned this route down, as "the desktop apps' scheduled tasks", for three reasons. Lite
answers each one:

- **One session sees its own earlier answers.** Every question goes to a fresh helper agent
  that gets only the question and a file path. In Claude Code that's a project agent,
  `.claude/agents/overheard-asker.md`, with its own system prompt, no CLAUDE.md and only web
  search and file writing. In Codex it's `.codex/agents/overheard_asker.toml`, started with no
  parent history. The main agent never tells a helper the brand or the competitors.
- **Nothing checks that each answer searched.** The helper must list its sources, and
  `overheard.py check` refuses an answer with no URL. That answer is asked once more, then
  marked failed.
- **The schedule depends on the app being open.** Still true, and the README says so. The
  Claude app runs a missed task once when the computer wakes.

The helpers' answers are files. The main agent reads each one into the brands it names, in
order, under the app's extraction rules. `overheard.py` then scores every run with ports of
`brand-matching.ts`, `selfReference.ts`, `finalize_run` and the dashboard's `aggregate`, and its
tests run the finalize-run fixtures through that scorer.

## Why

Many people who want Overheard AI have one Claude or ChatGPT plan and won't install a Node app
or buy API access. Their coding agent can already search, start helpers, write files and run on
a schedule in a folder.

## Consequences

- One assistant per plan, so no side-by-side comparison. A person with both plans uses two
  folders.
- The answers come from a coding agent with web search. Claude Code's helper also gets Claude
  Code's short subagent notes and the signed-in email. Codex's helper keeps Codex's base
  instructions, the folder path and the time zone. Setup warns about the email and the folder
  name.
- The main agent reads brands from answers without an enforced schema. `check` validates every
  reading and flags tracked brands it may have missed or invented.
- Linked is simpler than the app's citation rule: an answer that names a brand and links its
  domain anywhere, sources included, counts. The app counts only a link the extractor attaches
  to that brand, so Lite's Linked can read higher.
- Runs count against plan limits neither company publishes. A helper that fails is retried once,
  then marked failed.
- Only the person's own app starts their coding tool, through its own scheduled tasks. That
  avoids the open question in ADR 0007 about an app starting the tool on a plan.
